import OpenAI from "openai";
import { getOpenAiKey } from "@/lib/config/looker";
import { compactDynamicFieldForPrompt } from "@/lib/migration/dynamic-fields";
import {
  acceptMappingSuggestion,
  parseMetricViewInventory,
} from "@/lib/migration/field-mapping";
import type {
  ComparePolicyPatch,
  FailureTestEvidence,
  QueryPlanPatch,
  RuntimeDefect,
} from "@/lib/migration/reconciliation-overrides";
import {
  mergeScaffoldIntoAssets,
  scaffoldPassthroughDimensions,
} from "@/lib/migration/scaffold";
import type {
  FieldMappingEntry,
  FieldMappingTable,
  IntermediateRepresentation,
  ProposedAsset,
  SemanticMappingEvidence,
} from "@/lib/migration/types";

const MODEL = "gpt-5.6";

/**
 * Generate is structured Looker→metric-view translation with SQL evidence in-prompt;
 * medium is the quality/latency balance. Diagnose stays high for repair reasoning.
 */
const GENERATE_REASONING_EFFORT = "medium" as const;
const DIAGNOSE_REASONING_EFFORT = "high" as const;

/** Cap per-benchmark Looker SQL passed to the model. */
const MAX_BENCHMARK_SQL_CHARS = 4000;

/** Must match smoke/baseline sampling in lib/migration/test-cases.ts. */
const SMOKE_DIM_SAMPLE = 3;
const SMOKE_MEASURE_SAMPLE = 2;

function truncateSql(sql: string | undefined): string | undefined {
  if (!sql) return undefined;
  return sql.length > MAX_BENCHMARK_SQL_CHARS
    ? `${sql.slice(0, MAX_BENCHMARK_SQL_CHARS)}\n-- …truncated…`
    : sql;
}

/** Prefer the SQL of the executed query (json_bi metadata) over run_query SQL. */
function extractBenchmarkSql(b: {
  generatedSql?: string;
  jsonBi?: unknown;
}): string | undefined {
  const metaSql = (
    b.jsonBi as { metadata?: { sql?: string } } | undefined
  )?.metadata?.sql;
  return metaSql || b.generatedSql;
}

function bareFieldName(field: string): string {
  return field.split(".").pop()!.toLowerCase();
}

function addLookerFieldRefs(target: Set<string>, field: string | undefined) {
  if (!field) return;
  // sorts may be "view.field desc"
  const cleaned = field.replace(/\s+(asc|desc)\s*$/i, "").trim();
  if (!cleaned) return;
  target.add(bareFieldName(cleaned));
}

function addExpressionFieldRefs(
  target: Set<string>,
  expression: string | undefined
) {
  if (!expression) return;
  for (const match of expression.matchAll(/\$\{([^}]+)\}/g)) {
    addLookerFieldRefs(target, match[1]);
  }
}

/**
 * Bare field names the generate prompt must retain: tile benchmarks, filters,
 * dynamic-field formulas, explore grain, and the smoke/baseline sample dims.
 */
export function collectGenerateReferencedBareNames(
  inventory: IntermediateRepresentation
): Set<string> {
  const names = new Set<string>();

  const visibleDims = inventory.dimensions.filter((d) => !d.hidden);
  for (const d of visibleDims.slice(0, SMOKE_DIM_SAMPLE)) {
    addLookerFieldRefs(names, d.name);
  }
  for (const m of inventory.measures.slice(0, SMOKE_MEASURE_SAMPLE)) {
    addLookerFieldRefs(names, m.name);
  }

  for (const d of inventory.grain?.dimensions ?? []) {
    addLookerFieldRefs(names, d);
  }
  addLookerFieldRefs(names, inventory.grain?.primaryKey);
  addLookerFieldRefs(names, inventory.grain?.sqlDistinctKey);

  const considerTile = (tile: {
    fields?: string[];
    filters?: Record<string, string>;
    filterExpression?: string;
    sorts?: string[];
    pivots?: string[];
    dashboardFilters?: Record<string, string>;
    dynamicFields?: Array<{
      name: string;
      basedOn?: string;
      expression?: string;
      filters?: Record<string, string>;
    }>;
  }) => {
    for (const f of tile.fields ?? []) addLookerFieldRefs(names, f);
    for (const f of tile.pivots ?? []) addLookerFieldRefs(names, f);
    for (const f of tile.sorts ?? []) addLookerFieldRefs(names, f);
    for (const f of Object.keys(tile.filters ?? {})) addLookerFieldRefs(names, f);
    for (const f of Object.keys(tile.dashboardFilters ?? {})) {
      addLookerFieldRefs(names, f);
    }
    addExpressionFieldRefs(names, tile.filterExpression);
    for (const df of tile.dynamicFields ?? []) {
      addLookerFieldRefs(names, df.name);
      addLookerFieldRefs(names, df.basedOn);
      addExpressionFieldRefs(names, df.expression);
      for (const f of Object.keys(df.filters ?? {})) addLookerFieldRefs(names, f);
    }
  };

  for (const b of inventory.benchmarks ?? []) considerTile(b);
  for (const t of inventory.tileQueries ?? []) considerTile(t);

  // Inventory-level dynamic fields that match already-referenced bare names,
  // plus their basedOn / expression deps (one expansion pass).
  const allDyn =
    inventory.dynamicFields ??
    inventory.tileQueries.flatMap((t) => t.dynamicFields ?? []);
  for (const df of allDyn) {
    if (!names.has(bareFieldName(df.name))) continue;
    addLookerFieldRefs(names, df.basedOn);
    addExpressionFieldRefs(names, df.expression);
    for (const f of Object.keys(df.filters ?? {})) addLookerFieldRefs(names, f);
  }

  return names;
}

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = getOpenAiKey();
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    // Generate/diagnose on large explores routinely exceed the SDK default
    // (10 min). Keep one retry for transient network blips only.
    client = new OpenAI({
      apiKey,
      timeout: 20 * 60 * 1000,
      maxRetries: 1,
    });
  }
  return client;
}

/** Compact JSON for prompts — pretty-print doubles payload size for no gain. */
function promptJson(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Deduplicate truncated Looker SQL across benchmarks: share a sqlLibrary map
 * and reference by short key so repeated tile SQL shapes aren't re-sent 30×.
 */
function buildBenchmarkSqlLibrary(
  benchmarks: Array<{
    title: string;
    explore: string;
    fields: string[];
    filters?: Record<string, string>;
    filterExpression?: string;
    dynamicFields?: unknown[];
    generatedSql?: string;
    jsonBi?: unknown;
  }>
): {
  sqlLibrary: Record<string, string>;
  benchmarks: Array<Record<string, unknown>>;
} {
  const sqlLibrary: Record<string, string> = {};
  const sqlToKey = new Map<string, string>();
  let next = 1;

  const out = benchmarks.map((b) => {
    const sql = truncateSql(extractBenchmarkSql(b));
    let sqlRef: string | undefined;
    if (sql) {
      const existing = sqlToKey.get(sql);
      if (existing) {
        sqlRef = existing;
      } else {
        sqlRef = `s${next++}`;
        sqlToKey.set(sql, sqlRef);
        sqlLibrary[sqlRef] = sql;
      }
    }
    return {
      title: b.title,
      explore: b.explore,
      fields: b.fields,
      filters: b.filters,
      filterExpression: b.filterExpression,
      dynamicFields: (b.dynamicFields as Array<Parameters<
        typeof compactDynamicFieldForPrompt
      >[0]> | undefined)?.map(compactDynamicFieldForPrompt),
      ...(sqlRef ? { lookerSqlRef: sqlRef } : {}),
    };
  });

  return { sqlLibrary, benchmarks: out };
}

export interface GenerateAssetsInput {
  inventory: IntermediateRepresentation;
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
  devSchema: string;
  failedTests?: Array<{ name: string; summary: string; diff: string }>;
}

export interface GenerateAssetsOutput {
  assets: ProposedAsset[];
  rationale: string;
  unsupportedNotes: string[];
}

const fieldMappingEntrySchema = {
  type: "object" as const,
  properties: {
    lookerField: { type: "string" as const },
    metricViewName: { type: "string" as const },
    databricksField: { type: "string" as const },
    kind: { type: "string" as const, enum: ["dimension", "measure"] },
    currency: { type: "string" as const },
    unit: { type: "string" as const },
    populationGrain: { type: "string" as const },
    evidence: {
      type: "object" as const,
      properties: {
        aggregation: { type: "string" as const },
        filters: {
          type: "array" as const,
          items: { type: "string" as const },
        },
        currency: { type: "string" as const },
        unit: { type: "string" as const },
        populationGrain: { type: "string" as const },
        lookmlSql: { type: "string" as const },
        databricksExpr: { type: "string" as const },
        rationale: { type: "string" as const },
      },
      required: [
        "aggregation",
        "filters",
        "currency",
        "unit",
        "populationGrain",
        "lookmlSql",
        "databricksExpr",
        "rationale",
      ],
      additionalProperties: false,
    },
  },
  required: [
    "lookerField",
    "metricViewName",
    "databricksField",
    "kind",
    "currency",
    "unit",
    "populationGrain",
    "evidence",
  ],
  additionalProperties: false,
};

const generateSchema = {
  type: "object" as const,
  properties: {
    assets: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          type: {
            type: "string" as const,
            enum: [
              "sql_view",
              "metric_view",
              "row_filter",
              "function",
              "dashboard_calc",
            ],
          },
          name: { type: "string" as const },
          schema: { type: "string" as const },
          sql: { type: "string" as const },
          yaml: { type: "string" as const },
          description: { type: "string" as const },
          grain: { type: "string" as const },
          fieldMappings: {
            type: "array" as const,
            items: fieldMappingEntrySchema,
          },
        },
        required: [
          "type",
          "name",
          "schema",
          "description",
          "sql",
          "yaml",
          "grain",
          "fieldMappings",
        ],
        additionalProperties: false,
      },
    },
    rationale: { type: "string" as const },
    unsupportedNotes: {
      type: "array" as const,
      items: { type: "string" as const },
    },
  },
  required: ["assets", "rationale", "unsupportedNotes"],
  additionalProperties: false,
};

function normalizeEvidence(
  raw: SemanticMappingEvidence | undefined
): SemanticMappingEvidence | undefined {
  if (!raw) return undefined;
  return {
    aggregation: raw.aggregation?.trim() || undefined,
    filters: raw.filters?.filter(Boolean),
    currency: raw.currency?.trim() || undefined,
    unit: raw.unit?.trim() || undefined,
    populationGrain: raw.populationGrain?.trim() || undefined,
    lookmlSql: raw.lookmlSql?.trim() || undefined,
    databricksExpr: raw.databricksExpr?.trim() || undefined,
    rationale: raw.rationale?.trim() || "",
  };
}

function sanitizeFieldMappings(
  entries: FieldMappingEntry[] | undefined,
  assetName: string,
  inventory: IntermediateRepresentation
): FieldMappingEntry[] {
  if (!entries?.length) return [];
  const measureByName = new Map(
    inventory.measures.map((m) => [m.name.toLowerCase().split(".").pop()!, m])
  );

  const out: FieldMappingEntry[] = [];
  for (const entry of entries) {
    const lookerBare = entry.lookerField.split(".").pop()!.toLowerCase();
    const lookerMeasure = measureByName.get(lookerBare);
    const evidence = normalizeEvidence(entry.evidence);
    const verdict = acceptMappingSuggestion({
      lookerField: entry.lookerField,
      suggestedDatabricksField: entry.databricksField,
      lookerMeasure,
      databricksExpr: evidence?.databricksExpr,
      evidence,
    });
    if (!verdict.accept) continue;

    out.push({
      lookerField: entry.lookerField,
      // Always bind mappings to the asset they were declared on — GPT often
      // invents a parallel metricViewName that never gets deployed.
      metricViewName: assetName,
      databricksField: entry.databricksField,
      kind: entry.kind,
      currency: entry.currency?.trim() || evidence?.currency || undefined,
      unit: entry.unit?.trim() || evidence?.unit || undefined,
      populationGrain:
        entry.populationGrain?.trim() ||
        evidence?.populationGrain ||
        undefined,
      evidence,
    });
  }
  return out;
}

export async function generateDatabricksAssets(
  input: GenerateAssetsInput
): Promise<GenerateAssetsOutput> {
  const openai = getClient();

  const exploreName =
    input.inventory.source.explore || input.sourceTable;
  const scaffold = scaffoldPassthroughDimensions(
    input.inventory,
    exploreName
  );
  const scaffoldedSet = new Set(scaffold.scaffoldedBareNames);

  const referenced = collectGenerateReferencedBareNames(input.inventory);
  const visibleDims = input.inventory.dimensions.filter((d) => !d.hidden);
  const smokeBaselineFields = [
    ...visibleDims.slice(0, SMOKE_DIM_SAMPLE).map((d) => d.name),
    ...input.inventory.measures.slice(0, SMOKE_MEASURE_SAMPLE).map((m) => m.name),
  ];

  // Slim unused dashboard dynamic fields; explore fields stay.
  const allDynamicFields = (
    input.inventory.dynamicFields ??
    input.inventory.tileQueries.flatMap((t) => t.dynamicFields ?? [])
  ).filter(
    (f, i, arr) =>
      arr.findIndex(
        (x) =>
          x.kind === f.kind &&
          x.name.toLowerCase() === f.name.toLowerCase()
      ) === i
  );
  const dynamicFields = allDynamicFields.filter((f) =>
    referenced.has(bareFieldName(f.name))
  );

  // LLM only sees non-passthrough dimensions (CASE/liquid/params) — scaffold
  // handles the rest deterministically and merges after the call.
  const semanticDimensions = input.inventory.dimensions.filter(
    (d) => !d.hidden && !scaffoldedSet.has(bareFieldName(d.name))
  );

  const { sqlLibrary, benchmarks: compactBenchmarks } =
    buildBenchmarkSqlLibrary(input.inventory.benchmarks ?? []);

  const metadata = {
    source: input.inventory.source,
    dimensionCount: input.inventory.dimensions.length,
    measureCount: input.inventory.measures.length,
    joinCount: input.inventory.joins.length,
    tileQueryCount: input.inventory.tileQueries.length,
    dynamicFieldsIncluded: dynamicFields.length,
    dynamicFieldsOmitted: allDynamicFields.length - dynamicFields.length,
    grainDimensions: input.inventory.grain?.dimensions ?? [],
    smokeBaselineFields,
    /** Passthrough dims already scaffolded in-app — do NOT re-emit these. */
    scaffoldedPassthroughDimensions: scaffold.scaffoldedBareNames,
    /** Only non-trivial dimensions that need model reasoning. */
    dimensions: semanticDimensions.map((d) => ({
      name: d.name,
      type: d.type,
      sql: d.sql,
      label: d.label,
      description: d.description,
      valueFormat: d.valueFormat,
      tags: d.tags,
      hidden: d.hidden ?? false,
    })),
    measures: input.inventory.measures.map((m) => ({
      name: m.name,
      type: m.type,
      sql: m.sql,
      valueFormat: m.valueFormat,
      filters: m.filters,
      description: m.description,
      label: m.label,
      tags: m.tags,
    })),
    joins: input.inventory.joins,
    unsupportedFeatures: input.inventory.unsupportedFeatures,
    dynamicFields: dynamicFields.map(compactDynamicFieldForPrompt),
    sqlLibrary,
    benchmarks: compactBenchmarks,
  };

  const systemPrompt = `You are a data engineering assistant that migrates Looker semantic layers to Databricks Unity Catalog metric views.

Rules:
- Propose SQL views for transformations/deduplication when needed
- For sql_view assets, sql must be ONLY the view body (WITH ... SELECT or SELECT ...). Never include CREATE/OR REPLACE VIEW, LANGUAGE YAML, dollar-quotes, or markdown fences — the app wraps DDL.
- For metric_view assets, yaml must be ONLY the YAML document (version/source/dimensions|fields/measures). Never include CREATE VIEW, WITH METRICS, LANGUAGE YAML, $$ delimiters, or markdown fences — the app wraps DDL.
- For any expr/filter containing colons (e.g. SQL strings like 'Matched: In TAM') or CASE/WHEN, write it as a YAML block scalar: "expr: |-" then the SQL on the next indented line(s). Never put unquoted colons on the same line as "expr:".
- Propose Databricks metric view YAML (version: "1.1" required) for governed fields and measures
- Use row_filter or function types only when security requires it
- Multiple metric views are allowed for different grains
- Use dashboard_calc type for logic that does not belong in the semantic layer
- Never include credentials or raw data
- Target catalog: ${input.catalog}, base source table: ${input.catalog}.${input.sourceSchema}.${input.sourceTable}, deploy schema: ${input.devSchema}
- RECREATE JOINS IN STAGING VIEW: Looker explores join multiple views (listed in inventory.joins). You MUST recreate these joins in the sql_view using LEFT JOINs. The sql_view should act as a wide, denormalized table that pre-joins the base table with all joined tables using their sqlOn or foreignKey conditions.
- FAN-OUT WARNING: If a join is one-to-many, be careful with measure aggregations to avoid fan-out inflation. Pre-aggregate or use symmetric aggregate patterns if necessary.
- When a metric_view sources a sql_view from this proposal, set source to ${input.catalog}.${input.devSchema}.<sql_view_name>
- Metric view YAML keys: version ("1.1"), source, dimensions or fields (name, expr, and agent metadata), measures (name, expr, and agent metadata). Measures must be aggregate expressions.
- SOURCE-ONLY EXPRS (critical — Databricks hard rule): every dimension and measure \`expr\` is resolved against the metric-view \`source\` table/view columns ONLY. It CANNOT reference other dimension or measure names in the same YAML (no Looker-style \${view.sibling_dim}). If LookML uses another explore field, either (a) inline that field's SQL into the expr, or (b) materialize the column on the sql_view and reference the source column. Prefer (a) for simple CASE/order dims; prefer (b) when the same derived column is reused widely.
- Do NOT invent source columns. If a name is missing on source, add it to the sql_view SELECT (with real logic) or remap the expr to an existing source column — never leave a bare sibling dimension name in expr.
- Currency stems: physical warehouse columns are usually \`*_cad\` / \`*_usd\`. Looker \`*_selected\` / bare \`customer_gross_profit\` / \`customer_revenue\` / \`rate\` are NOT physical columns — in sql_view SQL materialize the CAD default (e.g. \`customer_gross_profit_cad AS customer_gross_profit_selected\` or \`… AS _mv_customer_gross_profit_selected\`). Never SELECT a bare currency stem that only exists as \`*_cad\`/\`*_usd\`.
- AGENT METADATA (required on every dimension/field and measure you emit — Databricks Genie / AI/BI):
  - display_name: human-readable Looker label (≤255 chars)
  - comment: Looker description / business meaning
  - synonyms: array of up to 10 alternate names (Looker labels, tags, common business aliases) for Genie discovery — optional for simple dimensions; required for measures
  - format: Databricks format map when known — currency {type: currency, currency_code}, percentage {type: percentage}, number {type: number}, date {type: date, date_format: year_month_day}
  - Prefer YAML key "comment" (not "description") on fields/measures
  - Do NOT invent synonyms that contradict the measure's currency/population

PASSTHROUGH DIMENSIONS (critical — do not waste tokens):
- inventory.scaffoldedPassthroughDimensions lists bare names the app already emits deterministically as 1:1 source columns.
- Do NOT re-emit those dimensions in YAML or fieldMappings. Focus on measures, dynamicFields, and the non-passthrough dimensions listed in inventory.dimensions.

NAMING (critical for tile benchmarks):
- Name the primary metric_view exactly after the Looker explore (e.g. explore tam_buildings → metric view tam_buildings). Do not append _metrics / _cad_default unless multiple grains truly require separate views.
- For every field used by inventory.benchmarks / tileQueries, the metric-view measure/dimension name (databricksField) MUST equal the Looker bare field name (after the view prefix). Example: fct_tam_buildings.revenue_estimate_sum_customer_adjusted → measure name revenue_estimate_sum_customer_adjusted.
- Implement Looker currency parameters using native Databricks Metric View parameters. Emit a \`parameters\` block in the YAML (with \`name\`, \`data_type\`, and \`default\`). Reference the parameter in the \`expr\` (e.g. \`CASE WHEN currency_selector = 'CAD' THEN ...\`). Do NOT rename benchmark measures to *_cad / *_usd unless Looker itself exposes separate _cad/_usd fields that tiles select.
- FULL EXPLORE EQUIVALENCE (required for measures + non-passthrough dims): emit EVERY inventory.measures entry and EVERY inventory.dimensions entry (the non-scaffolded list) with fieldMappings. The app merges scaffolded passthrough dims after your response.
- Also cover ALL measures and dimensions referenced by benchmarks / dynamicFields, with databricksField names matching Looker bare names.
- Always expose smokeBaselineFields and grainDimensions (with fieldMappings) when they are measures or non-scaffolded dims.
- EMPTY AGGREGATES (critical for Looker parity): Looker often returns 0 when an aggregate group has no contributing rows; Databricks MEASURE() returns null. For SUM/COUNT/AVG-style measure exprs, wrap with COALESCE(expr, 0) unless LookML explicitly preserves nulls.
- DASHBOARD DYNAMIC FIELDS (inventory.dynamicFields / benchmark.dynamicFields):
  - Custom measures (kind=measure, basedOn + type + filters): implement as metric-view measures with the SAME bare name; translate basedOn+filters into expr (FILTER WHERE / CASE).
  - Custom dimensions (kind=dimension, expression): implement as metric-view dimensions when the Looker expression can become SQL; otherwise dashboard_calc.
  - Table calculations (kind=table_calculation, expression): prefer promoting durable business metrics into metric-view measures; use dashboard_calc only for pure presentation math that cannot live in the semantic layer.
  - Never skip a benchmark field that has a dynamicFields formula — that formula IS the definition.
- Benchmark Looker SQL lives in sqlLibrary keyed by lookerSqlRef on each benchmark — resolve the ref before using SQL evidence.

FIELD MAPPING (required for every metric_view field YOU emit):
- Every Databricks dimension and measure you emit MUST declare a fieldMappings entry with:
  lookerField, metricViewName, databricksField, kind, currency, unit, populationGrain, evidence
- metricViewName MUST equal this asset's name
- evidence MUST include semantic rationale covering aggregation, filters, currency, and population/grain — never map by name similarity alone
- CAD vs USD (and other currencies) are different measures; never alias them because names look similar
- For dimensionless ratios / shares / margins / percentages: omit currency (do NOT set currency to "none") and set unit to "percent". CAD CASE branches inside the expr are fine; currency metadata must stay empty.
- Renamed Looker measures may map to differently named Databricks measures only with matching aggregation/filters/currency/population evidence
- Benchmark SQL is compiled ONLY from these mappings; Looker and Databricks names are never assumed identical
- For sql_view / non-metric assets, return fieldMappings as an empty array`;

  const userPrompt = input.failedTests?.length
    ? `Previous tests failed. Diagnose and propose patches.\n\nInventory metadata:\n${promptJson(metadata)}\n\nFailed tests:\n${promptJson(input.failedTests)}`
    : `Generate initial Databricks assets for this Looker inventory.\n\nInventory metadata:\n${promptJson(metadata)}`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: GENERATE_REASONING_EFFORT,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "databricks_assets",
        strict: true,
        schema: generateSchema,
      },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty response");

  const parsed = JSON.parse(content) as GenerateAssetsOutput;
  const sanitized = parsed.assets.map((asset) => ({
    ...asset,
    sql: asset.sql?.trim() ? asset.sql : undefined,
    yaml: asset.yaml?.trim() ? asset.yaml : undefined,
    grain: asset.grain?.trim() ? asset.grain : undefined,
    fieldMappings:
      asset.type === "metric_view"
        ? sanitizeFieldMappings(
            asset.fieldMappings,
            asset.name,
            input.inventory
          )
        : [],
  }));

  const merged = mergeScaffoldIntoAssets(
    sanitized,
    scaffold,
    exploreName
  );

  return {
    ...parsed,
    assets: merged,
  };
}

export interface DiagnoseInput {
  inventory: IntermediateRepresentation;
  failedTests: FailureTestEvidence[];
  currentAssets: ProposedAsset[];
  /** Persistent mapping retained across repair iterations. */
  fieldMapping?: FieldMappingTable | null;
  /** Dimension names exposed on deployed metric views (for plan-patch validation hints). */
  allowedFilterDimensions?: string[];
}

export interface DiagnoseOutput {
  diagnosis: string;
  patches: Array<{
    assetName: string;
    field: "sql" | "yaml" | "fieldMappings";
    newValue: string;
    rationale: string;
  }>;
  mappingPatches: FieldMappingEntry[];
  queryPlanPatches: QueryPlanPatch[];
  comparePatches: ComparePolicyPatch[];
  runtimeDefect: RuntimeDefect;
  needsHumanInput: boolean;
  humanInputReason?: string;
}

const queryPlanPatchSchema = {
  type: "object" as const,
  properties: {
    testName: { type: "string" as const },
    filters: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          field: { type: "string" as const },
          expression: { type: "string" as const },
        },
        required: ["field", "expression"],
        additionalProperties: false,
      },
    },
    predicates: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    rationale: { type: "string" as const },
  },
  required: ["testName", "filters", "predicates", "rationale"],
  additionalProperties: false,
};

const comparePatchSchema = {
  type: "object" as const,
  properties: {
    testName: { type: "string" as const },
    decimalScale: { type: "number" as const },
    forceKeyColumns: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    rationale: { type: "string" as const },
  },
  required: ["testName", "decimalScale", "forceKeyColumns", "rationale"],
  additionalProperties: false,
};

const runtimeDefectSchema = {
  type: "object" as const,
  properties: {
    present: { type: "boolean" as const },
    component: { type: "string" as const },
    summary: { type: "string" as const },
    repro: { type: "string" as const },
  },
  required: ["present", "component", "summary", "repro"],
  additionalProperties: false,
};

const diagnoseSchema = {
  type: "object" as const,
  properties: {
    diagnosis: { type: "string" as const },
    patches: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          assetName: { type: "string" as const },
          field: {
            type: "string" as const,
            enum: ["sql", "yaml", "fieldMappings"],
          },
          newValue: { type: "string" as const },
          rationale: { type: "string" as const },
        },
        required: ["assetName", "field", "newValue", "rationale"],
        additionalProperties: false,
      },
    },
    mappingPatches: {
      type: "array" as const,
      items: fieldMappingEntrySchema,
    },
    queryPlanPatches: {
      type: "array" as const,
      items: queryPlanPatchSchema,
    },
    comparePatches: {
      type: "array" as const,
      items: comparePatchSchema,
    },
    runtimeDefect: runtimeDefectSchema,
    needsHumanInput: { type: "boolean" as const },
    humanInputReason: { type: "string" as const },
  },
  required: [
    "diagnosis",
    "patches",
    "mappingPatches",
    "queryPlanPatches",
    "comparePatches",
    "runtimeDefect",
    "needsHumanInput",
    "humanInputReason",
  ],
  additionalProperties: false,
};

function benchmarkMatchesFailedTest(
  title: string,
  failedNames: Set<string>
): boolean {
  if (failedNames.has(title)) return true;
  for (const name of failedNames) {
    if (name === title) return true;
    if (name.startsWith("Smoke:") || name === "Baseline explore query") continue;
    if (name.includes(title) || title.includes(name)) return true;
  }
  return false;
}

/**
 * Shrink diagnose context to fields/SQL for failed tests only.
 * Falls back to fuller inventory on compile/unresolved failures so mapping
 * patches stay possible — without re-sending every tile's Looker SQL.
 */
function buildScopedDiagnoseContext(
  inventory: IntermediateRepresentation,
  failedTests: FailureTestEvidence[],
  unresolved: string[]
): {
  dimensions: IntermediateRepresentation["dimensions"];
  measures: IntermediateRepresentation["measures"];
  benchmarks: NonNullable<IntermediateRepresentation["benchmarks"]>;
  dynamicFields: ReturnType<typeof compactDynamicFieldForPrompt>[];
  scoped: boolean;
} {
  const failedNames = new Set(failedTests.map((t) => t.name));
  const hasCompileOrUnresolved = failedTests.some(
    (t) =>
      t.status === "query_compilation_error" ||
      (t.unresolvedLookerFields?.length ?? 0) > 0
  );

  const allBenchmarks = inventory.benchmarks ?? [];
  const relatedBenchmarks = allBenchmarks.filter((b) =>
    benchmarkMatchesFailedTest(b.title, failedNames)
  );

  const bareNames = new Set<string>();
  for (const u of unresolved) bareNames.add(bareFieldName(u));
  for (const b of relatedBenchmarks) {
    for (const f of b.fields ?? []) addLookerFieldRefs(bareNames, f);
    if (b.filterExpression) addExpressionFieldRefs(bareNames, b.filterExpression);
    for (const key of Object.keys(b.filters ?? {})) {
      addLookerFieldRefs(bareNames, key);
    }
  }

  const smokeOrBaseline = [...failedNames].some(
    (n) => n.startsWith("Smoke:") || n === "Baseline explore query"
  );
  if (smokeOrBaseline) {
    for (const d of inventory.grain?.dimensions ?? []) {
      addLookerFieldRefs(bareNames, d);
    }
    for (const m of inventory.measures.slice(0, SMOKE_MEASURE_SAMPLE)) {
      addLookerFieldRefs(bareNames, m.name);
    }
    for (const d of inventory.dimensions.slice(0, SMOKE_DIM_SAMPLE)) {
      addLookerFieldRefs(bareNames, d.name);
    }
  }

  // Compile failures or no field clues → keep full inventory dims/measures,
  // but still trim benchmarks/sqlLibrary to failures when we have matches.
  const useFullInventory =
    hasCompileOrUnresolved ||
    (bareNames.size === 0 && relatedBenchmarks.length === 0);

  const dimensions = useFullInventory
    ? inventory.dimensions
    : inventory.dimensions.filter((d) =>
        bareNames.has(bareFieldName(d.name))
      );
  const measures = useFullInventory
    ? inventory.measures
    : inventory.measures.filter((m) => bareNames.has(bareFieldName(m.name)));

  const benchmarksForPrompt =
    relatedBenchmarks.length > 0 ? relatedBenchmarks : allBenchmarks;

  const dynamicSource =
    inventory.dynamicFields ??
    inventory.tileQueries.flatMap((t) => t.dynamicFields ?? []);
  const dynamicFields = (
    useFullInventory
      ? dynamicSource
      : dynamicSource.filter((df) =>
          bareNames.has(String(df.name ?? "").toLowerCase())
        )
  ).map(compactDynamicFieldForPrompt);

  return {
    dimensions,
    measures,
    benchmarks: benchmarksForPrompt,
    dynamicFields,
    scoped: !useFullInventory || relatedBenchmarks.length > 0,
  };
}

export async function diagnoseFailures(
  input: DiagnoseInput
): Promise<DiagnoseOutput> {
  const openai = getClient();

  const metricViewInventories = input.currentAssets
    .filter((a) => a.type === "metric_view" && a.yaml)
    .map((a) => {
      try {
        return parseMetricViewInventory(a.name, a.yaml!);
      } catch {
        return { name: a.name, dimensions: [], measures: [] };
      }
    });

  const compactDiffs = input.failedTests.map((t) => ({
    name: t.name,
    mandatory: t.mandatory ?? false,
    summary: t.summary,
    status: t.status,
    unresolvedLookerFields: t.unresolvedLookerFields,
    metricViewName: t.metricViewName,
    sampleDiffs: t.columnDiffs.slice(0, 5),
    databricksSql: truncateSql(t.databricksSql),
    lookerSql: truncateSql(t.lookerSql),
    filterExpression: t.filterExpression,
    filters: t.filters,
    predicates: t.predicates,
    lookerRowCount: t.lookerRowCount,
    databricksRowCount: t.databricksRowCount,
    mismatchKind: t.mismatchKind,
    // Surface null↔0 so the model prefers COALESCE(expr, 0) over comparePatches.
    nullVsZeroHint:
      t.mismatchKind === "null_vs_zero" ||
      t.summary?.toLowerCase().includes("coalesce") ||
      t.summary?.toLowerCase().includes("looker 0 vs databricks null")
        ? "Patch measure expr with COALESCE(expr, 0); Looker returns 0 for empty aggregates, Databricks MEASURE() returns null."
        : undefined,
  }));

  const unresolved = Array.from(
    new Set(
      input.failedTests.flatMap((t) => t.unresolvedLookerFields ?? [])
    )
  );

  const lookmlForUnresolved = unresolved.map((field) => {
    const bare = field.split(".").pop()!.toLowerCase();
    const measure = input.inventory.measures.find(
      (m) => m.name.toLowerCase().split(".").pop() === bare
    );
    const dimension = input.inventory.dimensions.find(
      (d) => d.name.toLowerCase().split(".").pop() === bare
    );
    return {
      lookerField: field,
      measure: measure
        ? {
            name: measure.name,
            type: measure.type,
            sql: measure.sql,
            filters: measure.filters,
            valueFormat: measure.valueFormat,
            description: measure.description,
          }
        : null,
      dimension: dimension
        ? {
            name: dimension.name,
            type: dimension.type,
            sql: dimension.sql,
          }
        : null,
    };
  });

  const scoped = buildScopedDiagnoseContext(
    input.inventory,
    input.failedTests,
    unresolved
  );
  const { sqlLibrary, benchmarks: targetBenchmarks } = buildBenchmarkSqlLibrary(
    scoped.benchmarks
  );

  const response = await openai.chat.completions.create({
    model: MODEL,
    reasoning_effort: DIAGNOSE_REASONING_EFFORT,
    messages: [
      {
        role: "system",
        content: `Diagnose Looker vs Databricks deployment and reconciliation failures, including query_compilation_error from the field-mapping layer.

You have THREE patch planes (use the right one):
1) patches / mappingPatches — semantic SQL view / metric-view YAML / field mappings when measure defs or mappings are wrong.
2) queryPlanPatches — per-tile Databricks WHERE fixes when filter_expression / filters were dropped or mangled. testName must match the failed test name. filters use Looker-style field+expression; predicates are backtick-quoted dimension comparisons only (e.g. \`year\` >= 2020, \`month_date\` <= \`anchor_month\`, CAST(\`year\` AS STRING) <= CAST(YEAR(CURRENT_TIMESTAMP()) AS STRING)).
3) comparePatches — comparator knobs: decimalScale (-1 = unchanged), forceKeyColumns (e.g. account_number when keys collide). Empty testName = global.

Also set runtimeDefect.present=true when the failure is a platform/runtime bug you cannot express as (1)+(2)+(3) — include component (filter_compiler|comparator|field_mapping|other), summary, and repro. Prefer queryPlanPatches/comparePatches over runtimeDefect when a safe override exists.
- TABLE_OR_VIEW_NOT_FOUND on the metric view after deploy usually means YAML source does not point at the job's sql_view (or collides with the metric-view name). Patch source to catalog.devSchema.<sql_view_name> (the *_enriched / sql_view asset). Do NOT set needsHumanInput or runtimeDefect for that — emit a yaml source patch instead.

Rules:
- For unresolved columns, reconcile metric-view expressions against the SQL-view source OR update fieldMappings with semantic evidence.
- UNRESOLVED_COLUMN on deploy: Databricks resolves metric-view exprs against source columns only — not sibling dimensions. If the missing name is another dimension in the same YAML (e.g. order dim references sector_consolidated), INLINE that sibling's expr (or materialize it on the sql_view). If the missing name is not a sibling, add a real source column via the sql_view or remap to a column from the error suggestions. Do NOT set needsHumanInput/runtimeDefect for fixable sibling-inline or sql_view column adds.
- NEVER choose a Databricks measure merely by name similarity.
- Require semantic evidence for every mapping patch: aggregation, filters, currency, and population/grain must align.
- CAD vs USD (and other currencies) are distinct — do not alias them.
- For dimensionless ratios / shares / margins / percentages (ambiguous_currency with Looker "none" vs CAD-in-expr): clear currency on the mapping entry (omit the field; never use "none") and set unit to "percent". Keep CAD conversion inside expr if needed.
- When Databricks exposed *_cad/*_usd renames but Looker tiles select the original Looker measure names, prefer restoring Looker bare names on the metric view (CAD default in expr) over asking for human input.
- metricViewName in mappingPatches MUST match an asset name that exists in currentAssets. Prefer the explore name as the primary metric view name.
- When patching YAML, keep version "1.1" and preserve/fill agent metadata (display_name, comment, synonyms). Keep compatible format metadata, but MUST strip number/percentage/currency format from STRING columns (Databricks COLUMN_FORMAT_INCOMPATIBLE_WITH_COLUMN_TYPE) — omit format on those fields entirely.
- COLUMN_FORMAT_INCOMPATIBLE_WITH_COLUMN_TYPE deploy failures: remove the incompatible format from the named column (and any other string dims/measures with numeric formats). Prefer a YAML patch that deletes format keys; do not re-add percentage/number formats onto CASE/string fields.
- Do NOT wrap SQL/YAML in CREATE VIEW / WITH METRICS / $$ / markdown fences — deploy DDL is applied by the app.
- Return complete replacement content for each patched sql/yaml asset. Replacement YAML MUST retain EVERY existing dimension and measure from the current asset (only change the specific fields you are fixing) — dropping fields regresses compile fixes from earlier iterations.
- NEVER put Looker \${view.field} templates inside queryPlanPatches filters or predicates — they compile into string literals and cause CAST errors. Express cross-field conditions as backtick predicates (e.g. \`month_date\` <= \`anchor_month\`); the app already merges tile filters, so a queryPlanPatch predicate alone is sufficient.
- For fieldMappings patches, newValue must be a JSON array of mapping entries for that asset.
- Also return mappingPatches as structured FieldMappingEntry objects for the persistent mapping table.
- Set needsHumanInput=true only for ambiguous business logic that cannot be inferred from inventory, assets, evidence, or query/compare patches.
- Do NOT set needsHumanInput for missing LookML when the failure is a naming/routing mismatch (wrong metric view name, CAD rename, empty inventory for explore-named view) that you can patch from inventory + currentAssets.
- Each targetBenchmark includes lookerSqlRef into sqlLibrary: the exact SQL Looker generated for that tile. It is the AUTHORITATIVE definition of measure populations, CASE filters, and WHERE clauses. Prefer deriving measure expr patches from that SQL; prefer queryPlanPatches when only the Databricks WHERE grain differs.
- Distinguish shared explore/migration population from tile-specific filters: when the SAME Looker WHERE predicates appear in every relevant mandatory targetBenchmark SQL (e.g. the TAM property/sector/geography/minimum-size/search scope), patch the shared SQL staging view ONCE so smoke, baseline, and all tiles use the authoritative population. Use per-test queryPlanPatches only when predicates genuinely differ by tile. Never globalize a predicate that is absent from any relevant mandatory benchmark.
- dynamicFields on inventory/benchmarks are AUTHORITATIVE formulas for dashboard custom measures and table calculations. Use basedOn+filters or expression to implement missing measures — do NOT ask the human for table-calc definitions when dynamicFields already contains them.
- failedTests include databricksSql, filterExpression, filters, predicates, row counts, and mismatchKind. If databricksSql is missing Looker WHERE grain (e.g. 16 years vs 7), emit queryPlanPatches for that testName — do NOT bake tile-specific time filters into shared metric-view measures.
- failedTests.mandatory distinguishes required dashboard/Look benchmarks from synthetic smoke/baseline evidence. Prioritize actionable fixes for mandatory=true. Missing optional context for mandatory=false must NOT set needsHumanInput=true when you can safely patch required benchmarks; leave the synthetic test unpatched and allow the app to retest.
- The comparator already treats null and empty-string dimension keys as the same identity (summing collapsed measure groups) and uses scale-tolerant float compare. Do NOT cast measures to DOUBLE or emit comparePatches for tiny float dust / null-vs-empty symbol mismatches — those are not semantic failures.
- NULL vs 0 on measures IS a real semantic gap (not comparator noise): when sampleDiffs / mismatchKind show Looker 0 and Databricks null (or reverse), patch the measure expr to COALESCE(expr, 0). Prefer that over comparePatches. The app may also apply this deterministically for clear null↔0-only failures.
- Use comparePatches.forceKeyColumns when real business keys collide (e.g. need account_number); use decimalScale only when intentional rounding policy differs.
- Inventory/benchmarks in this prompt may be scoped to failed tests — request needsHumanInput rather than inventing missing LookML.
- Return empty arrays for unused patch planes. Set runtimeDefect.present=false when unused.`
      },
      {
        role: "user",
        content: promptJson({
          source: input.inventory.source,
          diagnoseScope: scoped.scoped
            ? "failed_tests_only"
            : "full_inventory_fallback",
          dimensions: scoped.dimensions.map((dimension) => ({
            name: dimension.name,
            sql: dimension.sql,
            type: dimension.type,
            label: dimension.label,
            description: dimension.description,
            valueFormat: dimension.valueFormat,
            tags: dimension.tags,
          })),
          measures: scoped.measures.map((measure) => ({
            name: measure.name,
            sql: measure.sql,
            type: measure.type,
            filters: measure.filters,
            valueFormat: measure.valueFormat,
            label: measure.label,
            description: measure.description,
            tags: measure.tags,
          })),
          currentFieldMapping: input.fieldMapping ?? null,
          unresolvedLookerFields: unresolved,
          lookmlForUnresolved,
          availableDatabricksMetricViews: metricViewInventories,
          currentAssets: input.currentAssets.map((a) => ({
            name: a.name,
            type: a.type,
            grain: a.grain,
            sql: a.sql,
            yaml: a.yaml,
            fieldMappings: a.fieldMappings,
          })),
          failedTests: compactDiffs,
          allowedFilterDimensions: input.allowedFilterDimensions ?? [],
          sqlLibrary,
          targetBenchmarks,
          dynamicFields: scoped.dynamicFields,
        }),
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "diagnosis",
        strict: true,
        schema: diagnoseSchema,
      },
    },
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty response");

  const parsed = JSON.parse(content) as DiagnoseOutput;

  const mappingPatches = (parsed.mappingPatches ?? [])
    .map((entry) => {
      const bare = entry.lookerField.split(".").pop()!.toLowerCase();
      const lookerMeasure = input.inventory.measures.find(
        (m) => m.name.toLowerCase().split(".").pop() === bare
      );
      const evidence = normalizeEvidence(entry.evidence);
      const verdict = acceptMappingSuggestion({
        lookerField: entry.lookerField,
        suggestedDatabricksField: entry.databricksField,
        lookerMeasure,
        databricksExpr: evidence?.databricksExpr,
        evidence,
      });
      if (!verdict.accept) return null;
      return {
        ...entry,
        currency: entry.currency?.trim() || evidence?.currency || undefined,
        unit: entry.unit?.trim() || evidence?.unit || undefined,
        populationGrain:
          entry.populationGrain?.trim() ||
          evidence?.populationGrain ||
          undefined,
        evidence,
      } as FieldMappingEntry;
    })
    .filter((e): e is FieldMappingEntry => Boolean(e));

  const runtimeDefect: RuntimeDefect = {
    present: Boolean(parsed.runtimeDefect?.present),
    component: parsed.runtimeDefect?.component?.trim() ?? "",
    summary: parsed.runtimeDefect?.summary?.trim() ?? "",
    repro: parsed.runtimeDefect?.repro?.trim() ?? "",
  };

  return {
    ...parsed,
    mappingPatches,
    queryPlanPatches: parsed.queryPlanPatches ?? [],
    comparePatches: parsed.comparePatches ?? [],
    runtimeDefect,
    humanInputReason: parsed.humanInputReason?.trim()
      ? parsed.humanInputReason
      : undefined,
  };
}

export function isOpenAiConfigured(): boolean {
  return Boolean(getOpenAiKey());
}
