/**
 * Patch fct_tam_buildings assets so Looker tile measure names exist on the
 * deployed metric view, write them to semantic_migration_dev, and run every
 * discovered tile benchmark. Prints real Databricks output for debugging.
 *
 * Usage: npx tsx scripts/validate-tam-tiles.ts [jobId]
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import {
  createMetricView,
  executeStatement,
  rowsFromResult,
} from "../lib/databricks/client";
import {
  compareRowSets,
  databricksResultToRowSet,
  lookerJsonBiToRowSet,
} from "../lib/migration/comparator";
import {
  compileBenchmarkFromMapping,
  formatCompilationError,
  loadMetricViewInventories,
  reconcileMappingMetricViewNames,
} from "../lib/migration/field-mapping";
import { buildMetricViewSelect } from "../lib/migration/query-builder";
import {
  prepareMetricViewForDeploy,
  prepareSqlViewForDeploy,
} from "../lib/migration/deploy-normalize";
import { query } from "../lib/db/client";
import type {
  FieldMappingEntry,
  FieldMappingTable,
  ProposedAsset,
} from "../lib/migration/types";

const JOB_ID_DEFAULT = "6a137060-baf6-4a33-ab14-31152e4ebe01";

/** Map Looker bare measure → existing CAD measure on the broken YAML. */
const LOOKER_TO_EXISTING_CAD: Record<string, string> = {
  revenue_estimate_sum_customer_adjusted: "revenue_estimate_sum_cad",
  customer_acv_year_sum_customer_adjusted: "customer_acv_year_sum_cad",
  revenue_share_customer_adjusted: "revenue_share_cad",
  customer_gross_profit_sum_customer_adjusted: "customer_gross_profit_sum_cad",
  customer_revenue_sum_customer_adjusted: "customer_revenue_sum_cad",
  customer_gross_margin_customer_adjusted: "customer_gross_margin_cad",
  max_rate: "median_rate_cad",
  // mapping sometimes used *_customer_adjusted_cad names that never existed
  revenue_estimate_sum_customer_adjusted_cad: "revenue_estimate_sum_cad",
  customer_acv_year_sum_customer_adjusted_cad: "customer_acv_year_sum_cad",
  revenue_share_customer_adjusted_cad: "revenue_share_cad",
  customer_gross_profit_sum_customer_adjusted_cad:
    "customer_gross_profit_sum_cad",
  customer_revenue_sum_customer_adjusted_cad: "customer_revenue_sum_cad",
  customer_gross_margin_customer_adjusted_cad: "customer_gross_margin_cad",
};

async function main() {
  const jobId = process.argv[2] || JOB_ID_DEFAULT;
  const outDir = path.resolve(process.cwd(), "tmp-debug");
  fs.mkdirSync(outDir, { recursive: true });

  const { rows: jobs } = await query<{
    id: string;
    warehouse_id: string;
    catalog: string;
    dev_schema: string;
    source_schema: string;
    source_table: string;
    migration_scope: unknown;
  }>(
    `SELECT id, warehouse_id, catalog, dev_schema, source_schema, source_table, migration_scope
     FROM migration_jobs WHERE id = $1`,
    [jobId]
  );
  const job = jobs[0];
  if (!job) throw new Error(`Job ${jobId} not found`);

  const { rows: arts } = await query<{
    artifact_type: string;
    name: string;
    content: string;
  }>(
    `SELECT artifact_type, name, content FROM migration_artifacts
     WHERE job_id = $1
     ORDER BY created_at DESC`,
    [jobId]
  );

  const sqlArt = arts.find(
    (a) => a.artifact_type === "sql" && a.name === "tam_buildings_semantic_base"
  );
  const yamlArt = arts.find(
    (a) => a.artifact_type === "yaml" && a.name.includes("tam_buildings")
  );
  const invArt = arts.find(
    (a) => a.artifact_type === "documentation" && a.name === "inventory"
  );
  const benchArt = arts.find(
    (a) => a.artifact_type === "documentation" && a.name === "looker_benchmarks"
  );
  if (!sqlArt || !yamlArt) {
    throw new Error("Missing sql/yaml artifacts for tam_buildings");
  }

  const benchmarks: Array<{
    tileId: string;
    jsonBi?: Record<string, unknown>;
  }> = benchArt ? JSON.parse(benchArt.content) : [];
  const benchmarkById = new Map(benchmarks.map((b) => [b.tileId, b]));

  const inventory = invArt ? JSON.parse(invArt.content) : null;
  const scope = job.migration_scope as {
    tiles: Array<{
      id: string;
      title: string;
      fields: string[];
      sorts?: string[];
      filters?: Record<string, string>;
      limit?: number;
      explore: string;
      pivots?: string[];
    }>;
  };

  let yamlDoc = parseYaml(yamlArt.content) as Record<string, unknown>;
  const measures = (yamlDoc.measures as Array<Record<string, unknown>>) ?? [];
  const measureByName = new Map(
    measures.map((m) => [String(m.name), m] as const)
  );

  // Ensure Looker bare names exist as measures (aliasing CAD exprs when needed)
  const tileFields = new Set<string>();
  for (const t of scope.tiles) {
    for (const f of t.fields ?? []) tileFields.add(f.split(".").pop()!);
  }
  // Also cover inventory measures commonly used in smoke tests
  for (const m of inventory?.measures ?? []) {
    const bare = String(m.name).split(".").pop()!;
    if (
      bare.includes("customer_adjusted") ||
      bare.includes("outside_tam") ||
      bare.includes("acv_match") ||
      bare.includes("buildings_count") ||
      bare.includes("customers_site") ||
      bare.includes("building_penetration") ||
      bare.includes("revenue_")
    ) {
      tileFields.add(bare);
    }
  }

  const added: string[] = [];
  for (const bare of tileFields) {
    if (measureByName.has(bare)) continue;
    const existingCad = LOOKER_TO_EXISTING_CAD[bare];
    if (existingCad && measureByName.has(existingCad)) {
      const src = measureByName.get(existingCad)!;
      const alias = { ...src, name: bare };
      measures.push(alias);
      measureByName.set(bare, alias);
      added.push(`${bare} <- ${existingCad}`);
      continue;
    }

    // Synthesize from inventory LookML when possible (CAD default for selected)
    const invMeasure = (inventory?.measures ?? []).find(
      (m: { name: string }) => m.name.split(".").pop() === bare
    );
    if (invMeasure) {
      const expr = lookmlToMetricExpr(invMeasure);
      if (expr) {
        const alias = { name: bare, expr };
        measures.push(alias);
        measureByName.set(bare, alias);
        added.push(`${bare} <- inventory:${invMeasure.type}`);
      }
    }
  }

  yamlDoc.measures = measures;
  // Prefer explore-named metric view for benchmark routing
  const metricViewName = "tam_buildings";
  yamlDoc.source = `${job.catalog}.${job.dev_schema}.tam_buildings_semantic_base`;
  const patchedYaml = stringifyYaml(yamlDoc);

  console.log("Added measure aliases:", added.length);
  for (const a of added) console.log(" ", a);

  // Build identity field mappings for all dimensions + measures on the view
  const dims = (yamlDoc.dimensions as Array<{ name: string }>) ?? [];
  const entries: FieldMappingEntry[] = [];
  for (const d of dims) {
    entries.push({
      lookerField: `fct_tam_buildings.${d.name}`,
      metricViewName,
      databricksField: d.name,
      kind: "dimension",
      currency: "N/A",
      unit: "text",
      populationGrain: "source row",
      evidence: {
        rationale: "Identity dimension mapping for tile validation",
        aggregation: "none",
        filters: [],
        currency: "N/A",
        unit: "text",
        populationGrain: "source row",
        lookmlSql: "",
        databricksExpr: d.name,
      },
    });
  }
  for (const m of measures) {
    const name = String(m.name);
    entries.push({
      lookerField: `fct_tam_buildings.${name}`,
      metricViewName,
      databricksField: name,
      kind: "measure",
      currency: detectCadUsd(name),
      unit: "number",
      populationGrain: "tile validation population",
      evidence: {
        rationale:
          "Identity measure mapping; CAD default for currency-selected Looker measures",
        aggregation: "from yaml",
        filters: [],
        currency: detectCadUsd(name),
        unit: "number",
        populationGrain: "tile validation population",
        lookmlSql: "",
        databricksExpr: String(m.expr ?? ""),
      },
    });
  }

  let mapping: FieldMappingTable = {
    version: "1.0",
    entries,
    updatedAt: new Date().toISOString(),
  };

  const assets: ProposedAsset[] = [
    {
      name: "tam_buildings_semantic_base",
      type: "sql_view",
      description: "semantic base",
      schema: job.dev_schema,
      sql: sqlArt.content,
    },
    {
      name: metricViewName,
      type: "metric_view",
      description: "patched metric view with Looker measure names",
      schema: job.dev_schema,
      yaml: patchedYaml,
      fieldMappings: entries,
    },
  ];
  mapping = reconcileMappingMetricViewNames(mapping, assets);

  fs.writeFileSync(path.join(outDir, "patched-metric-view.yaml"), patchedYaml);
  fs.writeFileSync(
    path.join(outDir, "patched-field-mapping.json"),
    JSON.stringify(mapping, null, 2)
  );

  console.log("\nDeploying to", `${job.catalog}.${job.dev_schema}…`);
  const viewBody = prepareSqlViewForDeploy(assets[0]);
  const sqlResult = await executeStatement(
    job.warehouse_id,
    `CREATE OR REPLACE VIEW \`${job.catalog}\`.\`${job.dev_schema}\`.\`tam_buildings_semantic_base\` AS ${viewBody}`
  );
  if (sqlResult.status !== "SUCCEEDED") {
    throw new Error(
      `SQL view deploy failed: ${sqlResult.error?.message ?? sqlResult.status}`
    );
  }
  console.log("Deployed sql_view tam_buildings_semantic_base");

  const yamlForDeploy = prepareMetricViewForDeploy(
    assets[1],
    job.catalog,
    job.dev_schema,
    ["tam_buildings_semantic_base"]
  );
  const mvResult = await createMetricView(
    job.warehouse_id,
    job.catalog,
    job.dev_schema,
    metricViewName,
    yamlForDeploy
  );
  if (mvResult.status !== "SUCCEEDED") {
    throw new Error(
      `Metric view deploy failed: ${mvResult.error?.message ?? mvResult.status}`
    );
  }
  console.log("Deployed metric_view", metricViewName);

  const inventories = loadMetricViewInventories(assets);
  const results: Array<Record<string, unknown>> = [];

  console.log(`\nRunning ${scope.tiles.length} tile benchmarks…\n`);
  for (const tile of scope.tiles) {
    if (tile.pivots && tile.pivots.length > 0) {
      results.push({
        title: tile.title,
        status: "unsupported",
        detail: "pivots unsupported",
      });
      console.log(`[unsupported] ${tile.title}`);
      continue;
    }

    // Merge tile filter_expression into filters (same logic as worker)
    const tileWithExpr = tile as typeof tile & { filterExpression?: string };
    const exprFilters: Record<string, string> = {};
    if (tileWithExpr.filterExpression) {
      const re = /matches_filter\(\s*\$\{([^}]+)\}\s*,\s*`([^`]*)`\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(tileWithExpr.filterExpression)) !== null) {
        const f = m[1].trim();
        exprFilters[f] = exprFilters[f] ? `${exprFilters[f]},${m[2].trim()}` : m[2].trim();
      }
    }
    const mergedFilters: Record<string, string> = { ...(tile.filters ?? {}) };
    for (const [f, e] of Object.entries(exprFilters)) {
      mergedFilters[f] = mergedFilters[f] ? `${mergedFilters[f]},${e}` : e;
    }

    const compiled = compileBenchmarkFromMapping({
      mapping,
      inventories,
      lookerFields: tile.fields,
      filters: Object.keys(mergedFilters).length ? mergedFilters : undefined,
      sorts: tile.sorts,
      preferredMetricView: tile.explore,
    });

    if (!compiled.ok) {
      const detail = formatCompilationError(compiled.issues);
      results.push({
        title: tile.title,
        status: "query_compilation_error",
        detail,
        fields: tile.fields,
      });
      console.log(`[compile_error] ${tile.title}`);
      console.log("  ", detail.slice(0, 300));
      continue;
    }

    const dbSql = buildMetricViewSelect({
      catalog: job.catalog,
      schema: job.dev_schema,
      viewName: compiled.metricViewName,
      fields: compiled.databricksFields,
      measureNames: compiled.measureNames,
      limit: tile.limit ?? 500,
      filters: compiled.filters,
      sorts: compiled.sorts,
    });

    const dbResult = await executeStatement(job.warehouse_id, dbSql, "50s");
    if (dbResult.status !== "SUCCEEDED") {
      results.push({
        title: tile.title,
        status: "error",
        detail: dbResult.error?.message,
        sql: dbSql,
      });
      console.log(`[error] ${tile.title}`);
      console.log("  ", (dbResult.error?.message ?? "").slice(0, 400));
      console.log("  SQL:", dbSql.slice(0, 200));
      continue;
    }

    const cols = dbResult.manifest?.schema?.columns?.map((c) => c.name) ?? [];
    const rows = rowsFromResult(dbResult);

    // True parity check against the captured Looker baseline when available
    const bench = benchmarkById.get(tile.id);
    let parity: string | undefined;
    let parityDetail: string | undefined;
    if (bench?.jsonBi) {
      const lookerRowSet = lookerJsonBiToRowSet(bench.jsonBi);
      const dbRowSet = databricksResultToRowSet(
        dbResult.manifest?.schema?.columns ?? [],
        rows
      );
      const outcome = compareRowSets(
        lookerRowSet,
        dbRowSet,
        {},
        { decimalScale: 2, timezone: "UTC" }
      );
      parity = outcome.match
        ? "match"
        : outcome.inconclusive
          ? "inconclusive"
          : "mismatch";
      parityDetail = outcome.summary;
      if (outcome.columnDiffs.length) {
        parityDetail += ` | first diffs: ${outcome.columnDiffs
          .slice(0, 3)
          .map(
            (d) =>
              `${d.column}[${d.rowIndex}] looker=${d.lookerValue} db=${d.databricksValue}`
          )
          .join("; ")}`;
      }
    }

    results.push({
      title: tile.title,
      status: parity === "match" ? "pass" : "ok_ran",
      parity,
      parityDetail,
      columns: cols,
      rowCount: rows.length,
      sampleRows: rows.slice(0, 3),
      sql: dbSql,
    });
    console.log(
      `[${parity ?? "ok"}] ${tile.title} — db ${rows.length} rows${parityDetail ? ` | ${parityDetail.slice(0, 220)}` : ""}`
    );
  }

  fs.writeFileSync(
    path.join(outDir, "tile-validation-results.json"),
    JSON.stringify(results, null, 2)
  );

  const summary = results.reduce<Record<string, number>>((acc, r) => {
    const s = String(r.status);
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});
  console.log("\n=== Summary ===");
  console.log(summary);
  console.log("Wrote", path.join(outDir, "tile-validation-results.json"));
}

function detectCadUsd(name: string): string {
  if (/_usd\b/i.test(name)) return "USD";
  if (/_cad\b/i.test(name)) return "CAD";
  return "CAD";
}

function lookmlToMetricExpr(m: {
  type?: string;
  sql?: string;
}): string | null {
  const sql = (m.sql ?? "").trim();
  if (!sql) return null;
  // Very small translator for common patterns — enough to smoke-test tiles.
  const cleaned = sql
    .replace(/\$\{TABLE\}\./g, "")
    .replace(/\$\{([^}]+)_selected\}/g, "$1_cad")
    .replace(/\$\{([^}]+)\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

  if (m.type === "count_distinct") {
    return `COUNT(DISTINCT ${cleaned.replace(/\/.*/, "").trim()})`;
  }
  if (m.type === "sum") {
    if (/^sum\s*\(/i.test(cleaned)) return cleaned;
    return `SUM(${cleaned})`;
  }
  if (m.type === "number" || m.type === "average") {
    // ratio measures referencing other measures — leave as-is for metric view
    return cleaned;
  }
  if (m.type === "count") return "COUNT(*)";
  return cleaned;
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
