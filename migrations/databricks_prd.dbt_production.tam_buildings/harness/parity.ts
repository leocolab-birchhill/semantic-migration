/**
 * Per-table parity harness entrypoint.
 * Prefer the shared CLI (keeps runner logic consistent across tables):
 *
 *   npm run cli:parity -- databricks_prd.dbt_production.tam_buildings
 *
 * Config: harness/parity.config.json
 * Results: harness/last-run.json
 */
console.log("Use: npm run cli:parity -- databricks_prd.dbt_production.tam_buildings");
