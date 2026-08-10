/**
 * Deterministic, type-aware comparator for Looker vs Databricks results.
 * Numeric LookML measure types (sum, count_distinct, median, …) are compared
 * numerically (incl. scientific notation). Dimension-keyed alignment avoids
 * cascading false fails when top-N row sets differ slightly at the LIMIT boundary.
 */

import { canonicalizeFieldName } from "@/lib/migration/query-builder";

export interface CompareConfig {
  decimalScale: number;
  timezone: string;
  /** When true (default), both sides empty is inconclusive rather than a pass. */
  requireNonEmpty?: boolean;
  /**
   * Minimum shared-key ratio (of max(lookerKeys, dbKeys)) for boundary_drift
   * when entity sets are not identical. Default 0.9.
   */
  boundaryOverlapRatio?: number;
  /**
   * When set, use these bare/canonical column names as row keys instead of
   * automatic dimension detection (agent compare-policy override).
   */
  forceKeyColumns?: string[];
}

/** True for null/undefined/whitespace-only — Looker often emits "" where Databricks emits null. */
export function isBlankDimValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string" && value.trim() === "") return true;
  return false;
}

/** Normalize a dimension cell for row identity (empty string ≡ null). */
export function normalizeKeyPart(value: unknown): string {
  if (isBlankDimValue(value)) return "\u0000";
  return String(value).trim();
}

/** UI-friendly row key (null/empty → em dash). */
export function humanizeRowKey(key: string): string {
  return key
    .split("\u0001")
    .map((part) => (part === "\u0000" ? "—" : part))
    .join(" · ");
}

/**
 * Numeric equality at the configured display scale without Math.round half-up
 * asymmetry (e.g. -180328.025 vs -180328.02500000002 must match at scale 2).
 */
export function numbersMatchAtScale(
  lNum: number,
  dNum: number,
  decimalScale: number
): boolean {
  if (Object.is(lNum, dNum) || lNum === dNum) return true;
  if (!Number.isFinite(lNum) || !Number.isFinite(dNum)) return false;
  const scale = Math.max(0, Math.floor(decimalScale));
  const absTol = Math.pow(10, -scale) / 2;
  const mag = Math.max(Math.abs(lNum), Math.abs(dNum));
  const dust = Math.max(1e-9, mag * Number.EPSILON * 16);
  return Math.abs(lNum - dNum) <= Math.max(absTol, dust);
}

export interface RowSet {
  columns: string[];
  rows: unknown[][];
}

export type CompareVerdict =
  | "match"
  | "boundary_drift"
  | "mismatch"
  | "inconclusive";

export interface CompareOutcome {
  /** Exact full match (same keys + matching measures). */
  match: boolean;
  /**
   * Measures match on shared keys, but a small top-N / LIMIT boundary set
   * differs. Usable architecture; not a semantic mapping failure.
   */
  boundaryDrift: boolean;
  inconclusive: boolean;
  verdict: CompareVerdict;
  lookerRowCount: number;
  databricksRowCount: number;
  sharedKeyCount: number;
  lookerOnlyKeyCount: number;
  databricksOnlyKeyCount: number;
  measureDiffCount: number;
  keyOverlapRatio: number;
  columnDiffs: Array<{
    column: string;
    rowIndex: number;
    lookerValue: unknown;
    databricksValue: unknown;
    match: boolean;
    /** Composite dimension key when key-aligned. */
    rowKey?: string;
    /** Optional repair hint (e.g. null↔0 → COALESCE). */
    hint?: string;
  }>;
  summary: string;
  /** Short non-technical explanation. */
  plainLanguageSummary: string;
}

function normalizeTimestamp(value: unknown, timezone: string): string | unknown {
  if (value === null || value === undefined) return value;
  const str = String(value);
  const date = new Date(str);
  if (isNaN(date.getTime())) return value;
  try {
    return date.toLocaleString("en-US", { timeZone: timezone });
  } catch {
    return str;
  }
}

/** LookML / IR types that should be compared as numbers. */
export function isNumericColType(colType: string): boolean {
  const type = colType.toLowerCase();
  if (
    type.includes("date") ||
    type.includes("time") ||
    type.includes("timestamp") ||
    type.includes("yesno") ||
    type.includes("bool") ||
    type.includes("string") ||
    type.includes("zip")
  ) {
    return false;
  }
  return (
    type.includes("int") ||
    type.includes("count") ||
    type.includes("sum") ||
    type.includes("average") ||
    type.includes("avg") ||
    type.includes("number") ||
    type.includes("decimal") ||
    type.includes("float") ||
    type.includes("double") ||
    type.includes("currency") ||
    type.includes("percent") ||
    type.includes("median") ||
    type.includes("max") ||
    type.includes("min") ||
    type.includes("measure") ||
    type.includes("tier") ||
    type.includes("duration")
  );
}

export function tryParseNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const s = String(value).trim().replace(/,/g, "");
  if (!s) return null;
  // Accept plain decimals and scientific notation from Databricks string cells.
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Looker 0 vs Databricks null (or reverse) — classic empty-aggregate COALESCE gap. */
export function isNullVsZeroMismatch(
  lookerVal: unknown,
  databricksVal: unknown
): boolean {
  const lBlank = isBlankDimValue(lookerVal);
  const dBlank = isBlankDimValue(databricksVal);
  const lZero = tryParseNumber(lookerVal) === 0;
  const dZero = tryParseNumber(databricksVal) === 0;
  return (lBlank && dZero) || (dBlank && lZero);
}

function nullZeroHint(
  lookerVal: unknown,
  databricksVal: unknown
): string | undefined {
  if (!isNullVsZeroMismatch(lookerVal, databricksVal)) return undefined;
  return "null_vs_zero: wrap measure expr in COALESCE(expr, 0) — Looker returns 0 for empty aggregates, Databricks MEASURE() returns null";
}

export function compareValue(
  lookerVal: unknown,
  databricksVal: unknown,
  colType: string,
  config: CompareConfig
): boolean {
  // null / "" / whitespace are the same empty dimension symbol across engines.
  if (isBlankDimValue(lookerVal) && isBlankDimValue(databricksVal)) return true;
  if (isBlankDimValue(lookerVal) || isBlankDimValue(databricksVal)) {
    // One blank, one not — only equal if the non-blank parses as nothing useful.
    // Keep null vs 0 as a real mismatch (COALESCE gaps).
    return false;
  }

  const type = colType.toLowerCase();

  if (type.includes("bool") || type.includes("yesno")) {
    const toBool = (v: unknown) => {
      if (typeof v === "boolean") return v;
      const s = String(v).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(s)) return true;
      if (["false", "no", "n", "0"].includes(s)) return false;
      return Boolean(v);
    };
    return toBool(lookerVal) === toBool(databricksVal);
  }

  if (type.includes("date") || type.includes("time") || type.includes("timestamp")) {
    const lNorm = normalizeTimestamp(lookerVal, config.timezone);
    const dNorm = normalizeTimestamp(databricksVal, config.timezone);
    return String(lNorm) === String(dNorm);
  }

  const lNum = tryParseNumber(lookerVal);
  const dNum = tryParseNumber(databricksVal);
  const numericByType = isNumericColType(colType);

  // Prefer numeric compare when the column is a measure type, or when both
  // cells parse as numbers (covers sum/median typed as string and Databricks
  // scientific-notation strings). Non-numeric labels fail tryParseNumber.
  if (lNum !== null && dNum !== null && (numericByType || type === "string" || !type)) {
    return numbersMatchAtScale(lNum, dNum, config.decimalScale);
  }

  if (numericByType) {
    return false;
  }

  return String(lookerVal).trim() === String(databricksVal).trim();
}

function canonicalSort(rows: unknown[][], colIndex: number): unknown[][] {
  return [...rows].sort((a, b) => {
    const av = a[colIndex];
    const bv = b[colIndex];
    if (av === bv) return 0;
    if (av === null || av === undefined) return -1;
    if (bv === null || bv === undefined) return 1;
    return String(av).localeCompare(String(bv));
  });
}

function resolveColType(
  col: string,
  columnTypes: Record<string, string>
): string {
  return (
    columnTypes[col] ??
    columnTypes[canonicalizeFieldName(col)] ??
    columnTypes[col.split(".").pop() ?? ""] ??
    "string"
  );
}

/** Resolve forced key column names to indexes on an aligned column list. */
export function forceKeyColumnIndexes(
  columns: string[],
  forceKeyColumns: string[]
): number[] {
  const wanted = new Set(
    forceKeyColumns.map((c) => canonicalizeFieldName(c))
  );
  const indexes: number[] = [];
  for (let ci = 0; ci < columns.length; ci++) {
    if (wanted.has(canonicalizeFieldName(columns[ci]))) {
      indexes.push(ci);
    }
  }
  return indexes;
}

/** Columns used as row identity (dimensions), not measures. */
export function identifyKeyColumnIndexes(
  columns: string[],
  columnTypes: Record<string, string>,
  sampleRows: unknown[][]
): number[] {
  const keys: number[] = [];
  for (let ci = 0; ci < columns.length; ci++) {
    const colType = resolveColType(columns[ci], columnTypes);
    if (isNumericColType(colType)) continue;

    const bare = canonicalizeFieldName(columns[ci]);
    // Numeric-looking string IDs (account_number, building_id, …) must stay keys.
    const looksLikeIdentifier =
      /(^id$|_id$|_number$|_code$|_key$|actnumbr|number$)/i.test(bare);

    // Heuristic: if inventory says string but every sample value is numeric,
    // treat as measure (e.g. missing type metadata) — unless the name is an ID.
    const sample = sampleRows
      .slice(0, 30)
      .map((r) => r[ci])
      .filter((v) => v !== null && v !== undefined && v !== "");
    if (
      !looksLikeIdentifier &&
      sample.length > 0 &&
      sample.every((v) => tryParseNumber(v) !== null) &&
      !colType.includes("date") &&
      !colType.includes("time")
    ) {
      continue;
    }
    keys.push(ci);
  }
  return keys;
}

function rowKey(row: unknown[], keyIndexes: number[]): string {
  return keyIndexes.map((i) => normalizeKeyPart(row[i])).join("\u0001");
}

/** Sum numeric measure cells when null/"" identity collapses duplicate keys. */
function mergeMeasureCell(existing: unknown, incoming: unknown): unknown {
  const a = tryParseNumber(existing);
  const b = tryParseNumber(incoming);
  if (a !== null && b !== null) return a + b;
  if (isBlankDimValue(existing)) return incoming;
  if (isBlankDimValue(incoming)) return existing;
  return existing;
}

/**
 * Build a key→row map. Blank dimension symbols collapse to one identity;
 * colliding rows sum numeric measures so Looker null+"" groups still pair
 * with Databricks double-null groups.
 */
export function buildKeyedRowMap(
  rows: unknown[][],
  keyIndexes: number[],
  measureIndexes: number[]
): { map: Map<string, unknown[]>; duplicateCollapses: number } {
  const map = new Map<string, unknown[]>();
  let duplicateCollapses = 0;
  for (const row of rows) {
    const key = rowKey(row, keyIndexes);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, [...row]);
      continue;
    }
    duplicateCollapses++;
    const merged = [...prev];
    for (const ci of measureIndexes) {
      merged[ci] = mergeMeasureCell(prev[ci], row[ci]);
    }
    // Prefer a non-blank display value on key columns when merging.
    for (const ki of keyIndexes) {
      if (isBlankDimValue(merged[ki]) && !isBlankDimValue(row[ki])) {
        merged[ki] = row[ki];
      }
    }
    map.set(key, merged);
  }
  return { map, duplicateCollapses };
}

/** Align two row sets onto a shared ordered column list by canonical name. */
export function alignRowSetsByName(
  looker: RowSet,
  databricks: RowSet
): {
  columns: string[];
  looker: RowSet;
  databricks: RowSet;
  missingInLooker: string[];
  missingInDatabricks: string[];
} {
  const lookerIndex = new Map(
    looker.columns.map((c, i) => [canonicalizeFieldName(c), i])
  );
  const dbIndex = new Map(
    databricks.columns.map((c, i) => [canonicalizeFieldName(c), i])
  );

  const sharedKeys = [...lookerIndex.keys()].filter((k) => dbIndex.has(k));
  const missingInDatabricks = [...lookerIndex.keys()].filter((k) => !dbIndex.has(k));
  const missingInLooker = [...dbIndex.keys()].filter((k) => !lookerIndex.has(k));

  const columns = sharedKeys.map((k) => {
    const li = lookerIndex.get(k)!;
    return looker.columns[li];
  });

  const lookerRows = looker.rows.map((row) =>
    sharedKeys.map((k) => row[lookerIndex.get(k)!] ?? null)
  );
  const dbRows = databricks.rows.map((row) =>
    sharedKeys.map((k) => row[dbIndex.get(k)!] ?? null)
  );

  return {
    columns,
    looker: { columns, rows: lookerRows },
    databricks: { columns, rows: dbRows },
    missingInLooker,
    missingInDatabricks,
  };
}

function emptyOutcome(
  partial: Partial<CompareOutcome> &
    Pick<CompareOutcome, "match" | "inconclusive" | "verdict" | "summary">
): CompareOutcome {
  return {
    boundaryDrift: false,
    lookerRowCount: 0,
    databricksRowCount: 0,
    sharedKeyCount: 0,
    lookerOnlyKeyCount: 0,
    databricksOnlyKeyCount: 0,
    measureDiffCount: 0,
    keyOverlapRatio: 0,
    columnDiffs: [],
    plainLanguageSummary: partial.summary,
    ...partial,
  };
}

export function compareRowSets(
  looker: RowSet,
  databricks: RowSet,
  columnTypes: Record<string, string>,
  config: CompareConfig
): CompareOutcome {
  const requireNonEmpty = config.requireNonEmpty !== false;
  const overlapThreshold = config.boundaryOverlapRatio ?? 0.9;

  if (requireNonEmpty && looker.rows.length === 0 && databricks.rows.length === 0) {
    return emptyOutcome({
      match: false,
      inconclusive: true,
      verdict: "inconclusive",
      summary:
        "Both sides returned 0 rows — inconclusive (not treated as a pass)",
      plainLanguageSummary:
        "Both Looker and Databricks returned no rows, so this tile could not be verified.",
    });
  }

  const aligned = alignRowSetsByName(looker, databricks);

  if (aligned.missingInDatabricks.length > 0 || aligned.missingInLooker.length > 0) {
    return emptyOutcome({
      match: false,
      inconclusive: false,
      verdict: "mismatch",
      lookerRowCount: looker.rows.length,
      databricksRowCount: databricks.rows.length,
      summary: `Column name mismatch. Missing in Databricks: [${aligned.missingInDatabricks.join(", ")}]. Missing in Looker: [${aligned.missingInLooker.join(", ")}]`,
      plainLanguageSummary:
        "Looker and Databricks returned different column names for this tile — the metric view mapping needs attention.",
    });
  }

  if (aligned.columns.length === 0) {
    return emptyOutcome({
      match: false,
      inconclusive: true,
      verdict: "inconclusive",
      lookerRowCount: looker.rows.length,
      databricksRowCount: databricks.rows.length,
      summary: "No shared columns to compare — inconclusive",
      plainLanguageSummary:
        "No overlapping columns to compare between Looker and Databricks.",
    });
  }

  const keyIndexes =
    config.forceKeyColumns && config.forceKeyColumns.length > 0
      ? forceKeyColumnIndexes(aligned.columns, config.forceKeyColumns)
      : identifyKeyColumnIndexes(
          aligned.columns,
          columnTypes,
          [...aligned.looker.rows, ...aligned.databricks.rows]
        );

  // Measure-only / scalar results: positional compare after stable sort.
  if (keyIndexes.length === 0) {
    return comparePositional(aligned, columnTypes, config);
  }

  return compareByKeys(aligned, keyIndexes, columnTypes, config, overlapThreshold);
}

function comparePositional(
  aligned: ReturnType<typeof alignRowSetsByName>,
  columnTypes: Record<string, string>,
  config: CompareConfig
): CompareOutcome {
  const sortCol = 0;
  const sortedLooker = canonicalSort(aligned.looker.rows, sortCol);
  const sortedDb = canonicalSort(aligned.databricks.rows, sortCol);
  const columnDiffs: CompareOutcome["columnDiffs"] = [];

  if (sortedLooker.length !== sortedDb.length) {
    return emptyOutcome({
      match: false,
      inconclusive: false,
      verdict: "mismatch",
      lookerRowCount: sortedLooker.length,
      databricksRowCount: sortedDb.length,
      summary: `Row count mismatch: Looker ${sortedLooker.length} vs Databricks ${sortedDb.length}`,
      plainLanguageSummary: `Looker returned ${sortedLooker.length} rows but Databricks returned ${sortedDb.length} — the results do not line up.`,
    });
  }

  let measureDiffCount = 0;
  for (let ri = 0; ri < sortedLooker.length; ri++) {
    for (let ci = 0; ci < aligned.columns.length; ci++) {
      const col = aligned.columns[ci];
      const colType = resolveColType(col, columnTypes);
      const lVal = sortedLooker[ri][ci];
      const dVal = sortedDb[ri][ci];
      const match = compareValue(lVal, dVal, colType, config);
      if (!match) {
        measureDiffCount++;
        if (columnDiffs.length < 40) {
          columnDiffs.push({
            column: col,
            rowIndex: ri,
            lookerValue: lVal,
            databricksValue: dVal,
            match: false,
            hint: nullZeroHint(lVal, dVal),
          });
        }
      }
    }
  }

  const allMatch = measureDiffCount === 0;
  const nullZeroDiffs = columnDiffs.filter((d) =>
    isNullVsZeroMismatch(d.lookerValue, d.databricksValue)
  ).length;
  const coalesceDominant =
    !allMatch && nullZeroDiffs > 0 && nullZeroDiffs >= measureDiffCount * 0.5;
  return {
    match: allMatch,
    boundaryDrift: false,
    inconclusive: false,
    verdict: allMatch ? "match" : "mismatch",
    lookerRowCount: sortedLooker.length,
    databricksRowCount: sortedDb.length,
    sharedKeyCount: sortedLooker.length,
    lookerOnlyKeyCount: 0,
    databricksOnlyKeyCount: 0,
    measureDiffCount,
    keyOverlapRatio: 1,
    columnDiffs,
    summary: allMatch
      ? `All ${sortedLooker.length} rows match`
      : coalesceDominant
        ? `${measureDiffCount} cell differences across ${sortedLooker.length} rows (mostly Looker 0 vs Databricks null — COALESCE gap)`
        : `${measureDiffCount} cell differences across ${sortedLooker.length} rows`,
    plainLanguageSummary: allMatch
      ? sortedLooker.length === 1
        ? "Looker and Databricks returned the same value for this tile."
        : `All ${sortedLooker.length} compared values match between Looker and Databricks.`
      : coalesceDominant
        ? `${measureDiffCount} value(s) differ — mostly Looker 0 vs Databricks null. Wrap those measure exprs in COALESCE(expr, 0).`
        : `${measureDiffCount} value(s) differ between Looker and Databricks.`,
  };
}

function compareByKeys(
  aligned: ReturnType<typeof alignRowSetsByName>,
  keyIndexes: number[],
  columnTypes: Record<string, string>,
  config: CompareConfig,
  overlapThreshold: number
): CompareOutcome {
  const measureIndexes = aligned.columns
    .map((_, i) => i)
    .filter((i) => !keyIndexes.includes(i));

  const { map: lookerMap } = buildKeyedRowMap(
    aligned.looker.rows,
    keyIndexes,
    measureIndexes
  );
  const { map: dbMap } = buildKeyedRowMap(
    aligned.databricks.rows,
    keyIndexes,
    measureIndexes
  );

  const sharedKeys = [...lookerMap.keys()].filter((k) => dbMap.has(k));
  const lookerOnly = [...lookerMap.keys()].filter((k) => !dbMap.has(k));
  const dbOnly = [...dbMap.keys()].filter((k) => !lookerMap.has(k));
  const maxKeys = Math.max(lookerMap.size, dbMap.size, 1);
  const keyOverlapRatio = sharedKeys.length / maxKeys;

  const columnDiffs: CompareOutcome["columnDiffs"] = [];
  let measureDiffCount = 0;

  for (let si = 0; si < sharedKeys.length; si++) {
    const key = sharedKeys[si];
    const lRow = lookerMap.get(key)!;
    const dRow = dbMap.get(key)!;
    for (const ci of measureIndexes) {
      const col = aligned.columns[ci];
      const colType = resolveColType(col, columnTypes);
      const lVal = lRow[ci];
      const dVal = dRow[ci];
      const match = compareValue(lVal, dVal, colType, config);
      if (!match) {
        measureDiffCount++;
        if (columnDiffs.length < 40) {
          columnDiffs.push({
            column: col,
            rowIndex: si,
            lookerValue: lVal,
            databricksValue: dVal,
            match: false,
            rowKey: humanizeRowKey(key),
            hint: nullZeroHint(lVal, dVal),
          });
        }
      }
    }
  }

  // Sample key-set diffs so diagnosis/UI can see boundary entities.
  for (const k of lookerOnly.slice(0, 5)) {
    columnDiffs.push({
      column: aligned.columns[keyIndexes[0]],
      rowIndex: -1,
      lookerValue: humanizeRowKey(k),
      databricksValue: null,
      match: false,
      rowKey: humanizeRowKey(k),
    });
  }
  for (const k of dbOnly.slice(0, 5)) {
    columnDiffs.push({
      column: aligned.columns[keyIndexes[0]],
      rowIndex: -1,
      lookerValue: null,
      databricksValue: humanizeRowKey(k),
      match: false,
      rowKey: humanizeRowKey(k),
    });
  }

  const lookerRowCount = aligned.looker.rows.length;
  const databricksRowCount = aligned.databricks.rows.length;
  const setDiff = lookerOnly.length + dbOnly.length;

  if (measureDiffCount === 0 && setDiff === 0) {
    return {
      match: true,
      boundaryDrift: false,
      inconclusive: false,
      verdict: "match",
      lookerRowCount,
      databricksRowCount,
      sharedKeyCount: sharedKeys.length,
      lookerOnlyKeyCount: 0,
      databricksOnlyKeyCount: 0,
      measureDiffCount: 0,
      keyOverlapRatio: 1,
      columnDiffs: [],
      summary: `All ${lookerRowCount} rows match`,
      plainLanguageSummary: `All ${lookerRowCount} rows match between Looker and Databricks.`,
    };
  }

  // Values that can be paired all match. Differing entity lists are top-N /
  // tie-break / unordered-LIMIT sampling — not measure-definition failures.
  if (measureDiffCount === 0 && sharedKeys.length > 0) {
    const pct = Math.round(keyOverlapRatio * 100);
    const highOverlap = keyOverlapRatio >= overlapThreshold;
    const summary =
      `Values match on ${sharedKeys.length}/${maxKeys} entities` +
      ` (${lookerOnly.length} only in Looker, ${dbOnly.length} only in Databricks)` +
      (highOverlap
        ? " — top-N / LIMIT boundary drift"
        : " — list membership differs (ranking ties or unstable ORDER BY/LIMIT)");
    return {
      match: false,
      boundaryDrift: true,
      inconclusive: false,
      verdict: "boundary_drift",
      lookerRowCount,
      databricksRowCount,
      sharedKeyCount: sharedKeys.length,
      lookerOnlyKeyCount: lookerOnly.length,
      databricksOnlyKeyCount: dbOnly.length,
      measureDiffCount: 0,
      keyOverlapRatio,
      columnDiffs,
      summary,
      plainLanguageSummary: highOverlap
        ? `Metric values match for shared rows (${sharedKeys.length} of ${maxKeys}). ` +
          `A few entities differ at the top-N cutoff — usual with live data / ranking ties, not a broken metric definition.`
        : `Every overlapping entity has matching metric values (${sharedKeys.length} shared, ${pct}% overlap). ` +
          `The Looker and Databricks top-N lists still differ (${lookerOnly.length} only in Looker, ${dbOnly.length} only in Databricks) — ` +
          `usually ranking ties or a tile with no stable sort, not wrong measure math.`,
    };
  }

  if (measureDiffCount === 0 && sharedKeys.length === 0) {
    return {
      match: false,
      boundaryDrift: false,
      inconclusive: true,
      verdict: "inconclusive",
      lookerRowCount,
      databricksRowCount,
      sharedKeyCount: 0,
      lookerOnlyKeyCount: lookerOnly.length,
      databricksOnlyKeyCount: dbOnly.length,
      measureDiffCount: 0,
      keyOverlapRatio: 0,
      columnDiffs,
      summary: `No shared entities to compare (Looker ${lookerRowCount} rows, Databricks ${databricksRowCount} rows) — likely unstable ORDER BY/LIMIT sampling`,
      plainLanguageSummary:
        "Looker and Databricks returned completely different row samples (often unordered LIMIT queries), so values could not be paired. This does not prove the metrics are wrong.",
    };
  }

  const summary =
    `${measureDiffCount} measure differences on ${sharedKeys.length} shared entities` +
    (setDiff > 0
      ? ` (+${lookerOnly.length} Looker-only, ${dbOnly.length} Databricks-only keys)`
      : "");

  const nullZeroDiffs = columnDiffs.filter(
    (d) =>
      d.rowIndex >= 0 &&
      isNullVsZeroMismatch(d.lookerValue, d.databricksValue)
  ).length;
  const coalesceDominant =
    measureDiffCount > 0 &&
    nullZeroDiffs > 0 &&
    nullZeroDiffs >= measureDiffCount * 0.5;

  return {
    match: false,
    boundaryDrift: false,
    inconclusive: false,
    verdict: "mismatch",
    lookerRowCount,
    databricksRowCount,
    sharedKeyCount: sharedKeys.length,
    lookerOnlyKeyCount: lookerOnly.length,
    databricksOnlyKeyCount: dbOnly.length,
    measureDiffCount,
    keyOverlapRatio,
    columnDiffs,
    summary: coalesceDominant
      ? `${summary} (mostly Looker 0 vs Databricks null — COALESCE gap)`
      : summary,
    plainLanguageSummary: coalesceDominant
      ? `${measureDiffCount} metric value(s) differ for the same entities — mostly Looker 0 vs Databricks null. Wrap those measure exprs in COALESCE(expr, 0).`
      : `${measureDiffCount} metric value(s) differ for the same entities — review the measure definitions.`,
  };
}

function unwrapJsonBiCell(cell: unknown): unknown {
  if (cell && typeof cell === "object" && "value" in (cell as object)) {
    return (cell as { value: unknown }).value;
  }
  return cell;
}

/**
 * Parse a Looker json_bi payload into a RowSet.
 *
 * Actual json_bi shape: { metadata: { fields, has_totals, ... },
 * rows: [ { "view.field": { value } } ] }. When has_totals is true, Looker
 * appends a totals row (dimensions null) which must not count for parity.
 * A legacy { data: [...] } shape is still accepted.
 */
export function lookerJsonBiToRowSet(
  jsonBi: Record<string, unknown>
): RowSet {
  const metadata = jsonBi.metadata as
    | {
        fields?: {
          dimensions?: Array<{ name: string }>;
          measures?: Array<{ name: string }>;
        };
        has_totals?: boolean;
      }
    | undefined;

  let rawRows = jsonBi.rows as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(rawRows)) {
    rawRows = jsonBi.data as Array<Record<string, unknown>> | undefined;
  }

  const metaColumns = [
    ...(metadata?.fields?.dimensions ?? []),
    ...(metadata?.fields?.measures ?? []),
  ].map((f) => f.name);

  if (!rawRows || rawRows.length === 0) {
    if (metaColumns.length > 0) {
      return { columns: metaColumns, rows: [] };
    }
    const fields = jsonBi.fields as Array<{ name: string }> | undefined;
    if (fields && fields.length > 0) {
      return { columns: fields.map((f) => f.name), rows: [] };
    }
    return { columns: [], rows: [] };
  }

  // Totals row: appended last when has_totals is true.
  let dataRows = rawRows;
  if (metadata?.has_totals && dataRows.length > 0) {
    dataRows = dataRows.slice(0, -1);
  }

  const columns = metaColumns.length > 0 ? metaColumns : Object.keys(rawRows[0]);
  const rows = dataRows.map((row) =>
    columns.map((c) => unwrapJsonBiCell(row[c]) ?? null)
  );
  return { columns, rows };
}

export function databricksResultToRowSet(
  columns: Array<{ name: string; type_name?: string }>,
  dataArray: string[][]
): RowSet {
  const colNames = columns.map((c) => c.name);
  const rows = dataArray.map((row) => row.map((v) => (v === "" ? null : v)));
  return { columns: colNames, rows };
}

export type ParityMismatchKind =
  | "none"
  | "value_mismatch"
  | "null_vs_zero"
  | "list_membership"
  | "unordered_sample"
  | "column_mismatch"
  | "row_count";

export interface ParityPreviewRow {
  label: string;
  lookerValue: unknown;
  databricksValue: unknown;
  match: boolean;
  kind: "shared" | "looker_only" | "databricks_only" | "value_diff";
}

export interface ParityPreview {
  why: string;
  mismatchKind: ParityMismatchKind;
  sharedCount: number;
  lookerOnlyCount: number;
  databricksOnlyCount: number;
  measureDiffCount: number;
  /** Shared rows (and value diffs) for the table. */
  rows: ParityPreviewRow[];
  /** Entities only in Looker (sample). */
  lookerOnlySample: string[];
  /** Entities only in Databricks (sample). */
  databricksOnlySample: string[];
}

/**
 * Build a compact side-by-side preview for non-technical scorecards.
 * Prefer scalar tiles; otherwise show a few shared keyed rows.
 */
export function buildValuePreview(
  looker: RowSet,
  databricks: RowSet,
  maxRows = 5
): Array<{
  label: string;
  lookerValue: unknown;
  databricksValue: unknown;
  match: boolean;
}> {
  return buildParityPreview(looker, databricks, maxRows).rows.map((r) => ({
    label: r.label,
    lookerValue: r.lookerValue,
    databricksValue: r.databricksValue,
    match: r.match,
  }));
}

/**
 * Rich preview for the scorecard: why a tile passed/failed, shared samples,
 * and Looker-only / Databricks-only entities when list membership differs.
 * Uses the same identity / numeric rules as compareRowSets.
 */
export function buildParityPreview(
  looker: RowSet,
  databricks: RowSet,
  maxRows = 5,
  config: Partial<CompareConfig> = {}
): ParityPreview {
  const cfg: CompareConfig = {
    decimalScale: config.decimalScale ?? 2,
    timezone: config.timezone ?? "UTC",
    forceKeyColumns: config.forceKeyColumns,
    boundaryOverlapRatio: config.boundaryOverlapRatio,
    requireNonEmpty: config.requireNonEmpty,
  };

  const empty: ParityPreview = {
    why: "No comparable rows available.",
    mismatchKind: "none",
    sharedCount: 0,
    lookerOnlyCount: 0,
    databricksOnlyCount: 0,
    measureDiffCount: 0,
    rows: [],
    lookerOnlySample: [],
    databricksOnlySample: [],
  };

  const aligned = alignRowSetsByName(looker, databricks);
  if (aligned.columns.length === 0) {
    return {
      ...empty,
      why: "Column names do not overlap between Looker and Databricks.",
      mismatchKind: "column_mismatch",
    };
  }

  const keyIndexes =
    cfg.forceKeyColumns && cfg.forceKeyColumns.length > 0
      ? forceKeyColumnIndexes(aligned.columns, cfg.forceKeyColumns)
      : identifyKeyColumnIndexes(
          aligned.columns,
          {},
          [...aligned.looker.rows, ...aligned.databricks.rows]
        );

  // Scalar / single-measure tiles
  if (
    aligned.columns.length === 1 ||
    (keyIndexes.length === 0 &&
      aligned.looker.rows.length <= 1 &&
      aligned.databricks.rows.length <= 1)
  ) {
    const rows: ParityPreviewRow[] = [];
    let diffs = 0;
    for (let ci = 0; ci < aligned.columns.length; ci++) {
      const lv = aligned.looker.rows[0]?.[ci] ?? null;
      const dv = aligned.databricks.rows[0]?.[ci] ?? null;
      const match = compareValue(lv, dv, "number", cfg);
      if (!match) diffs++;
      rows.push({
        label: aligned.columns[ci].split(".").pop() ?? aligned.columns[ci],
        lookerValue: lv,
        databricksValue: dv,
        match,
        kind: match ? "shared" : "value_diff",
      });
    }
    return {
      why:
        diffs === 0
          ? "Looker and Databricks returned the same value(s)."
          : "One or more metric values differ between Looker and Databricks.",
      mismatchKind: diffs === 0 ? "none" : "value_mismatch",
      sharedCount: diffs === 0 ? 1 : 0,
      lookerOnlyCount: 0,
      databricksOnlyCount: 0,
      measureDiffCount: diffs,
      rows,
      lookerOnlySample: [],
      databricksOnlySample: [],
    };
  }

  if (keyIndexes.length === 0) {
    if (aligned.looker.rows.length !== aligned.databricks.rows.length) {
      return {
        ...empty,
        why: `Row counts differ (Looker ${aligned.looker.rows.length} vs Databricks ${aligned.databricks.rows.length}).`,
        mismatchKind: "row_count",
      };
    }
    return empty;
  }

  const measureIndexes = aligned.columns
    .map((_, i) => i)
    .filter((i) => !keyIndexes.includes(i));
  const { map: lookerMap } = buildKeyedRowMap(
    aligned.looker.rows,
    keyIndexes,
    measureIndexes
  );
  const { map: dbMap } = buildKeyedRowMap(
    aligned.databricks.rows,
    keyIndexes,
    measureIndexes
  );
  const sharedKeys = [...lookerMap.keys()].filter((k) => dbMap.has(k));
  const lookerOnly = [...lookerMap.keys()].filter((k) => !dbMap.has(k));
  const dbOnly = [...dbMap.keys()].filter((k) => !lookerMap.has(k));

  // Recount all measure diffs.
  let measureDiffCount = 0;
  const valueDiffRows: ParityPreviewRow[] = [];
  const sharedSampleRows: ParityPreviewRow[] = [];

  for (const key of sharedKeys) {
    const lRow = lookerMap.get(key)!;
    const dRow = dbMap.get(key)!;
    const label = humanizeRowKey(key);
    if (measureIndexes.length === 0) {
      sharedSampleRows.push({
        label,
        lookerValue: label,
        databricksValue: label,
        match: true,
        kind: "shared",
      });
      continue;
    }
    let rowHasDiff = false;
    for (const ci of measureIndexes) {
      const lv = lRow[ci];
      const dv = dRow[ci];
      const match = compareValue(lv, dv, "number", cfg);
      if (!match) {
        measureDiffCount++;
        if (!rowHasDiff && valueDiffRows.length < maxRows) {
          valueDiffRows.push({
            label: `${label} · ${aligned.columns[ci].split(".").pop()}`,
            lookerValue: lv,
            databricksValue: dv,
            match: false,
            kind: "value_diff",
          });
          rowHasDiff = true;
        }
      }
    }
    if (!rowHasDiff && sharedSampleRows.length < maxRows) {
      const ci = measureIndexes[0];
      sharedSampleRows.push({
        label: `${label} · ${aligned.columns[ci].split(".").pop()}`,
        lookerValue: lRow[ci],
        databricksValue: dRow[ci],
        match: true,
        kind: "shared",
      });
    }
  }

  const rows = [
    ...valueDiffRows,
    ...sharedSampleRows.slice(0, Math.max(0, maxRows - valueDiffRows.length)),
  ];

  const lookerOnlySample = lookerOnly.slice(0, 5).map(humanizeRowKey);
  const databricksOnlySample = dbOnly.slice(0, 5).map(humanizeRowKey);

  let mismatchKind: ParityMismatchKind = "none";
  let why: string;
  if (measureDiffCount > 0) {
    const nullZeroSample = valueDiffRows.filter((r) =>
      isNullVsZeroMismatch(r.lookerValue, r.databricksValue)
    ).length;
    const coalesceDominant =
      nullZeroSample > 0 && nullZeroSample >= valueDiffRows.length * 0.5;
    mismatchKind = coalesceDominant ? "null_vs_zero" : "value_mismatch";
    why = coalesceDominant
      ? `${measureDiffCount} metric value(s) differ — mostly Looker 0 vs Databricks null (empty aggregate). Wrap those measure exprs in COALESCE(expr, 0).`
      : `${measureDiffCount} metric value(s) differ on entities present in both Looker and Databricks. Shared samples below highlight disagreements.`;
  } else if (sharedKeys.length === 0) {
    mismatchKind = "unordered_sample";
    why =
      "No overlapping entities in the returned samples (often an unordered LIMIT). Metric values could not be paired — this does not prove measures are wrong.";
  } else if (lookerOnly.length > 0 || dbOnly.length > 0) {
    mismatchKind = "list_membership";
    why =
      `Metric values match on all ${sharedKeys.length} shared entities. ` +
      `The mismatch is the entity list itself: ${lookerOnly.length} only in Looker, ${dbOnly.length} only in Databricks ` +
      `(typical causes: ranking ties at LIMIT, or a tile with no stable sort).`;
  } else {
    why = `All ${sharedKeys.length} entities match between Looker and Databricks.`;
  }

  return {
    why,
    mismatchKind,
    sharedCount: sharedKeys.length,
    lookerOnlyCount: lookerOnly.length,
    databricksOnlyCount: dbOnly.length,
    measureDiffCount,
    rows,
    lookerOnlySample,
    databricksOnlySample,
  };
}
