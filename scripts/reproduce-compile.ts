/**
 * Reproduce compileBenchmarkFromMapping against saved job artifacts.
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

import {
  compileBenchmarkFromMapping,
  loadMetricViewInventories,
  formatCompilationError,
} from "../lib/migration/field-mapping";
import type { ProposedAsset, FieldMappingTable } from "../lib/migration/types";

async function main() {
  const dir = path.resolve(process.cwd(), "tmp-debug");
  const snap = JSON.parse(
    fs.readFileSync(path.join(dir, "artifact_asset_snapshot_final_v1.txt"), "utf8")
  );
  const mapping = JSON.parse(
    fs.readFileSync(path.join(dir, "artifact_documentation_field_mapping_v1.txt"), "utf8")
  ) as FieldMappingTable;
  const job = JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
  const tests = JSON.parse(fs.readFileSync(path.join(dir, "tests.json"), "utf8"));

  const assets = snap.assets as ProposedAsset[];
  const inventories = loadMetricViewInventories(assets);
  console.log(
    "Inventories:",
    [...inventories.entries()].map(([k, v]) => ({
      k,
      dims: v.dimensions.length,
      measures: v.measures.length,
      measureNames: v.measures.map((m) => m.name),
    }))
  );
  console.log("Mapping entries:", mapping.entries.length);
  console.log(
    "Mapping metric views:",
    [...new Set(mapping.entries.map((e) => e.metricViewName))]
  );

  // Reproduce a few failing tiles from migration_scope
  const samples = [
    {
      name: "Revenue Estimate in TAM",
      fields: ["fct_tam_buildings.revenue_estimate_sum_customer_adjusted"],
      preferred: "tam_buildings",
    },
    {
      name: "Building Penetration",
      fields: [
        "fct_tam_buildings.building_penetration",
        "fct_tam_buildings.building_penetration_customer_adjusted",
      ],
      preferred: "tam_buildings",
    },
    {
      name: "TAM Metrics by Facility Type",
      fields: [
        "fct_tam_buildings.sector",
        "fct_tam_buildings.buildings_count_customer_adjusted",
        "fct_tam_buildings.revenue_estimate_sum_customer_adjusted",
        "fct_tam_buildings.building_sf_occupied_by_account_adjusted_sum",
        "fct_tam_buildings.avg_acct_sf_per_building_customer_adjusted",
        "fct_tam_buildings.max_rate",
      ],
      preferred: "tam_buildings",
    },
  ];

  // Also try preferred = tam_buildings_metrics (actual asset name)
  for (const preferred of ["tam_buildings", "tam_buildings_metrics", "tam_buildings_cad_default"]) {
    console.log(`\n===== preferred=${preferred} =====`);
    for (const s of samples) {
      const compiled = compileBenchmarkFromMapping({
        mapping,
        inventories,
        lookerFields: s.fields,
        preferredMetricView: preferred,
      });
      console.log(
        `\n[${s.name}] ok=${compiled.ok} view=${compiled.metricViewName} fields=${compiled.databricksFields.join(",")}`
      );
      if (!compiled.ok) {
        console.log("  issues:", formatCompilationError(compiled.issues).slice(0, 500));
      }
    }
  }

  // What did saved tests actually use?
  console.log("\n===== saved test SQL samples =====");
  for (const t of tests.slice(0, 5)) {
    console.log(t.test_name, "=>", (t.databricks_sql || "").slice(0, 200));
  }

  // Check whether empty mapping + inventing identity would explain SQL
  const emptyMapping: FieldMappingTable = {
    version: "1.0",
    entries: [],
    updatedAt: new Date().toISOString(),
  };
  console.log("\n===== empty mapping =====");
  const c = compileBenchmarkFromMapping({
    mapping: emptyMapping,
    inventories,
    lookerFields: ["fct_tam_buildings.revenue_estimate_sum_customer_adjusted"],
    preferredMetricView: "tam_buildings_metrics",
  });
  console.log("ok", c.ok, formatCompilationError(c.issues).slice(0, 300));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
