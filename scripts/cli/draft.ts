#!/usr/bin/env npx tsx
/**
 * OpenAI one-shot draft: inventory (+ optional baseline) → generate → write
 * migrations/<catalog.schema.table>/draft + harness config.
 *
 *   npm run cli:draft -- --scope tmp-debug/scope-draft.json
 *   npm run cli:draft -- --scope <file> --skip-baseline
 *
 * Does NOT call diagnose. Local Cursor owns repair after cli:deploy / cli:parity.
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import type {
  ConfirmedMigrationScope,
  DiscoveredTile,
  DiscoveredView,
  IntermediateRepresentation,
} from "../../lib/migration/types";

interface ScopeDraft {
  sourceTable: { catalog: string; schema: string; table: string };
  databricks: {
    host: string;
    warehouseId: string;
    devSchema: string;
    prodSchema?: string;
  };
  options?: {
    maxIterations?: number;
    decimalScale?: number;
    timezone?: string;
  };
  explores: Array<{ include?: boolean; model: string; explore: string }>;
  tiles: Array<DiscoveredTile & { include?: boolean }>;
  views?: DiscoveredView[];
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function inventoryFromScope(
  scope: ConfirmedMigrationScope,
  timezone: string,
  skipBaseline: boolean
): Promise<IntermediateRepresentation> {
  const { buildScopedInventory } = await import("../../lib/migration/inventory");
  let inventory = await buildScopedInventory(scope);

  if (!skipBaseline && scope.tiles.length > 0) {
    const { captureLookerBenchmarks } = await import(
      "../../lib/migration/baseline"
    );
    const { mergeDynamicFields } = await import(
      "../../lib/migration/dynamic-fields"
    );
    console.log(
      `[draft] Capturing ${scope.tiles.length} Looker benchmark(s)…`
    );
    const benchmarks = await captureLookerBenchmarks(scope, timezone);
    inventory = {
      ...inventory,
      benchmarks,
      dynamicFields: mergeDynamicFields(
        inventory.dynamicFields,
        benchmarks.flatMap((b) => b.dynamicFields ?? [])
      ),
    };
  } else if (skipBaseline) {
    console.log("[draft] --skip-baseline: not recapturing Looker tiles");
  } else {
    console.log("[draft] No tiles in scope — explore-only draft");
  }
  return inventory;
}

async function main() {
  const args = process.argv.slice(2);
  const scopeFile = argValue(args, "--scope");
  const skipBaseline = args.includes("--skip-baseline");

  if (!scopeFile) {
    console.error(
      "Usage: npm run cli:draft -- --scope <scope-draft.json> [--skip-baseline]"
    );
    process.exit(1);
  }

  const draft = JSON.parse(
    fs.readFileSync(path.resolve(scopeFile), "utf8")
  ) as ScopeDraft;
  if (
    !draft.databricks?.warehouseId ||
    draft.databricks.warehouseId === "SET_ME"
  ) {
    console.error("Set databricks.warehouseId in the scope draft first");
    process.exit(1);
  }
  const explores = (draft.explores ?? []).filter((e) => e.include !== false);
  const tiles = (draft.tiles ?? [])
    .filter((t) => t.include !== false)
    .map(({ include: _i, ...t }) => t as DiscoveredTile);
  const scope: ConfirmedMigrationScope = {
    sourceTable: draft.sourceTable,
    explores: explores.map((e) => ({ model: e.model, explore: e.explore })),
    tiles,
    views: draft.views ?? [],
  };
  const catalog = draft.sourceTable.catalog;
  const sourceSchema = draft.sourceTable.schema;
  const sourceTable = draft.sourceTable.table;
  const devSchema = draft.databricks.devSchema;
  const warehouseId = draft.databricks.warehouseId;
  const databricksHost = draft.databricks.host;
  const decimalScale = draft.options?.decimalScale ?? 2;
  const timezone = draft.options?.timezone ?? "UTC";
  let inventory = await inventoryFromScope(scope, timezone, skipBaseline);

  console.log(
    `[draft] OpenAI one-shot generate for ${catalog}.${sourceSchema}.${sourceTable}…`
  );
  const { generateDatabricksAssets } = await import("../../lib/openai/client");
  const { sanitizeGeneratedAssets } = await import(
    "../../lib/migration/deploy-normalize"
  );
  const {
    collectFieldMappings,
    mergeFieldMappings,
    reconcileMappingMetricViewNames,
    repairAmbiguousCurrencyMappings,
    applyMappingTableToAssets,
  } = await import("../../lib/migration/field-mapping");

  const generated = await generateDatabricksAssets({
    inventory,
    catalog,
    sourceSchema,
    sourceTable,
    devSchema,
  });

  let assets = sanitizeGeneratedAssets(
    generated.assets,
    catalog,
    devSchema,
    inventory
  );
  let fieldMapping = mergeFieldMappings(
    inventory.fieldMapping ?? {
      version: "1.0",
      entries: [],
      updatedAt: new Date().toISOString(),
    },
    collectFieldMappings(assets, inventory)
  );
  fieldMapping = reconcileMappingMetricViewNames(fieldMapping, assets);
  fieldMapping = repairAmbiguousCurrencyMappings(fieldMapping, inventory);
  assets = applyMappingTableToAssets(assets, fieldMapping);
  assets = sanitizeGeneratedAssets(assets, catalog, devSchema, {
    ...inventory,
    fieldMapping,
  });
  inventory = { ...inventory, fieldMapping };

  const { writeMigrationArtifacts } = await import(
    "../../lib/migration/repo-artifacts"
  );
  const written = writeMigrationArtifacts({
    catalog,
    sourceSchema,
    sourceTable,
    devSchema,
    warehouseId,
    databricksHost,
    decimalScale,
    timezone,
    prodSchema: draft.databricks.prodSchema ?? "business_semantics",
    scope,
    inventory,
    assets,
    fieldMapping,
  });

  console.log(`[draft] Wrote ${written.root}`);
  console.log(`[draft] Rationale: ${generated.rationale?.slice(0, 240) ?? "(none)"}`);
  console.log("\nNext:");
  console.log(`  npm run cli:deploy -- ${written.tableKey}`);
  console.log(`  npm run cli:parity -- ${written.tableKey}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[draft] Fatal:", err);
    process.exit(1);
  });
