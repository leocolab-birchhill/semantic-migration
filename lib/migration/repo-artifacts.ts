/**
 * Persist migration draft artifacts under migrations/<catalog.schema.table>/
 * for the OpenAI-draft → Cursor-local-fix workflow.
 */
import fs from "fs";
import path from "path";
import type {
  ConfirmedMigrationScope,
  IntermediateRepresentation,
  ProposedAsset,
  FieldMappingTable,
} from "@/lib/migration/types";

export interface ParityHarnessConfig {
  version: "1";
  tableKey: string;
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
  devSchema: string;
  warehouseId: string;
  databricksHost: string;
  prodSchema?: string;
  decimalScale: number;
  timezone: string;
  jobId?: string;
  metricViewName?: string;
  tiles: Array<{
    tileId: string;
    title: string;
    model: string;
    explore: string;
    fields: string[];
    mandatory: boolean;
  }>;
  /** Optional Cursor/local knobs */
  forceKeyColumns?: string[];
}

export function migrationTableKey(input: {
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
}): string {
  return `${input.catalog}.${input.sourceSchema}.${input.sourceTable}`;
}

export function migrationDir(tableKey: string, cwd = process.cwd()): string {
  return path.join(cwd, "migrations", tableKey);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeText(filePath: string, value: string) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, "utf8");
}

export interface WriteMigrationArtifactsInput {
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
  devSchema: string;
  warehouseId: string;
  databricksHost: string;
  decimalScale?: number;
  timezone?: string;
  prodSchema?: string;
  jobId?: string;
  scope?: ConfirmedMigrationScope | null;
  inventory: IntermediateRepresentation;
  assets: ProposedAsset[];
  fieldMapping?: FieldMappingTable | null;
  /** Extra note written into harness/last-run when pausing for local fix */
  pauseReason?: string | null;
}

export function writeMigrationArtifacts(
  input: WriteMigrationArtifactsInput
): { tableKey: string; root: string } {
  const tableKey = migrationTableKey(input);
  const root = migrationDir(tableKey);
  ensureDir(root);
  ensureDir(path.join(root, "draft"));
  ensureDir(path.join(root, "harness"));
  ensureDir(path.join(root, "edge-cases"));

  if (input.scope) {
    writeJson(path.join(root, "scope.json"), {
      ...input.scope,
      databricks: {
        host: input.databricksHost,
        warehouseId: input.warehouseId,
        catalog: input.catalog,
        devSchema: input.devSchema,
        prodSchema: input.prodSchema ?? "business_semantics",
      },
    });
  }

  writeJson(path.join(root, "inventory.json"), input.inventory);

  const sqlViews = input.assets.filter((a) => a.type === "sql_view");
  const metricViews = input.assets.filter((a) => a.type === "metric_view");

  if (sqlViews.length === 1 && sqlViews[0].sql) {
    writeText(path.join(root, "draft", "sql_view.sql"), sqlViews[0].sql.trim() + "\n");
  } else if (sqlViews.length > 1) {
    for (const v of sqlViews) {
      if (!v.sql?.trim()) continue;
      writeText(
        path.join(root, "draft", `sql_view_${v.name}.sql`),
        v.sql.trim() + "\n"
      );
    }
  }

  if (metricViews.length === 1 && metricViews[0].yaml) {
    writeText(
      path.join(root, "draft", "metric_view.yaml"),
      metricViews[0].yaml.trim() + "\n"
    );
  } else {
    for (const v of metricViews) {
      if (!v.yaml?.trim()) continue;
      writeText(
        path.join(root, "draft", `metric_view_${v.name}.yaml`),
        v.yaml.trim() + "\n"
      );
    }
  }

  writeJson(path.join(root, "draft", "assets.json"), input.assets);
  writeJson(
    path.join(root, "draft", "field_mappings.json"),
    input.fieldMapping ?? input.inventory.fieldMapping ?? { entries: [] }
  );

  const primaryMv = metricViews[0]?.name;
  const harness: ParityHarnessConfig = {
    version: "1",
    tableKey,
    catalog: input.catalog,
    sourceSchema: input.sourceSchema,
    sourceTable: input.sourceTable,
    devSchema: input.devSchema,
    warehouseId: input.warehouseId,
    databricksHost: input.databricksHost,
    decimalScale: input.decimalScale ?? 2,
    timezone: input.timezone ?? "UTC",
    prodSchema: input.prodSchema ?? "business_semantics",
    jobId: input.jobId,
    metricViewName: primaryMv,
    tiles: (input.inventory.benchmarks ?? []).map((b) => ({
      tileId: b.tileId,
      title: b.title,
      model: b.model,
      explore: b.explore,
      fields: b.fields,
      mandatory: true,
    })),
  };
  writeJson(path.join(root, "harness", "parity.config.json"), harness);

  // Fixed runner stub — the real runner is scripts/cli/parity.ts.
  writeText(
    path.join(root, "harness", "parity.ts"),
    `/**
 * Per-table parity harness entrypoint.
 * Prefer the shared CLI (keeps runner logic consistent across tables):
 *
 *   npm run cli:parity -- ${tableKey}
 *
 * Config: harness/parity.config.json
 * Results: harness/last-run.json
 */
console.log("Use: npm run cli:parity -- ${tableKey}");
`
  );

  if (input.pauseReason) {
    writeJson(path.join(root, "harness", "awaiting-local-fix.json"), {
      pausedAt: new Date().toISOString(),
      reason: input.pauseReason,
      nextSteps: [
        "Read harness/last-run.json (or awaiting-local-fix.json)",
        "Consult cases/ and migrations/<table>/edge-cases/",
        "Patch draft/sql_view.sql and draft/metric_view.yaml",
        "npm run cli:deploy -- " + tableKey,
        "npm run cli:parity -- " + tableKey,
        "Add an edge-case note when the fix lands",
      ],
    });
  }

  // README for humans/Cursor
  if (!fs.existsSync(path.join(root, "README.md"))) {
    writeText(
      path.join(root, "README.md"),
      `# Migration: ${tableKey}

Artifacts for the OpenAI one-shot draft → local Cursor fix loop.

- \`draft/\` — SQL view + metric-view YAML (edit these when fixing)
- \`harness/parity.config.json\` — tile benchmarks + knobs
- \`harness/last-run.json\` — latest parity diffs / SQL errors
- \`edge-cases/\` — lessons from Cursor fixes for this table

Commands:

\`\`\`bash
npm run cli:deploy -- ${tableKey}
npm run cli:parity -- ${tableKey}
\`\`\`
`
    );
  }

  return { tableKey, root };
}

export function readParityConfig(
  tableKey: string,
  cwd = process.cwd()
): ParityHarnessConfig {
  const file = path.join(migrationDir(tableKey, cwd), "harness", "parity.config.json");
  if (!fs.existsSync(file)) {
    throw new Error(`Missing parity config: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as ParityHarnessConfig;
}

export function readDraftAssets(
  tableKey: string,
  cwd = process.cwd()
): ProposedAsset[] {
  const draftDir = path.join(migrationDir(tableKey, cwd), "draft");
  const assetsFile = path.join(draftDir, "assets.json");
  if (fs.existsSync(assetsFile)) {
    return JSON.parse(fs.readFileSync(assetsFile, "utf8")) as ProposedAsset[];
  }

  // Rebuild minimal assets from individual files
  const assets: ProposedAsset[] = [];
  const sqlPath = path.join(draftDir, "sql_view.sql");
  const yamlPath = path.join(draftDir, "metric_view.yaml");
  const mappingsPath = path.join(draftDir, "field_mappings.json");
  const mappings = fs.existsSync(mappingsPath)
    ? (JSON.parse(fs.readFileSync(mappingsPath, "utf8")) as FieldMappingTable)
    : null;

  if (fs.existsSync(sqlPath)) {
    assets.push({
      type: "sql_view",
      name: "source_enriched",
      schema: "semantic_migration_dev",
      sql: fs.readFileSync(sqlPath, "utf8"),
      description: "Staging SQL view from draft/sql_view.sql",
    });
  }
  if (fs.existsSync(yamlPath)) {
    const yaml = fs.readFileSync(yamlPath, "utf8");
    const nameMatch = yaml.match(/^\s*#\s*name:\s*(\S+)/m);
    assets.push({
      type: "metric_view",
      name: nameMatch?.[1] ?? "metric_view",
      schema: "semantic_migration_dev",
      yaml,
      description: "Metric view from draft/metric_view.yaml",
      fieldMappings: mappings?.entries,
    });
  }
  if (!assets.length) {
    throw new Error(`No draft assets found under ${draftDir}`);
  }
  return assets;
}
