/**
 * Skill-facing migration runtime: deploy / parity / publish.
 * No Postgres job queue — artifacts live under migrations/<table>/.
 */
import {
  createMetricView,
  executeStatement,
  rowsFromResult,
} from "@/lib/databricks/client";
import {
  getQuerySql,
  runInlineQuery,
  type LookerQueryWrite,
} from "@/lib/looker/client";
import {
  compareRowSets,
  databricksResultToRowSet,
  isNullVsZeroMismatch,
  lookerJsonBiToRowSet,
} from "@/lib/migration/comparator";
import { mapPool } from "@/lib/migration/concurrency";
import {
  prepareMetricViewForDeploy,
  prepareSqlViewForDeploy,
  sortAssetsForDeploy,
} from "@/lib/migration/deploy-normalize";
import {
  compileBenchmarkFromMapping,
  formatCompilationError,
  loadMetricViewInventories,
} from "@/lib/migration/field-mapping";
import {
  buildColumnTypes,
  buildMetricViewSelect,
  parseLookerFilterExpression,
} from "@/lib/migration/query-builder";
import {
  emptyOverrides,
  resolveCompareConfigForTest,
  resolveQueryPlanForTest,
  type FailureTestEvidence,
  type ReconciliationOverrides,
} from "@/lib/migration/reconciliation-overrides";
import {
  assertSafeWriteSchema,
  validateMigrationSchemas,
} from "@/lib/migration/schema-guard";
import type {
  FieldMappingTable,
  IntermediateRepresentation,
  MigrationJobRecord,
  ProposedAsset,
  TestCase,
} from "@/lib/migration/types";

const PARITY_CONCURRENCY = 6;

export async function deployAssetsToDev(
  job: MigrationJobRecord,
  assets: ProposedAsset[],
  inventory?: IntermediateRepresentation | null
): Promise<Array<{ type: string; name: string; fqn: string }>> {
  assertSafeWriteSchema(job.devSchema, "dev");
  const ordered = sortAssetsForDeploy(assets);
  const sqlViewNames = ordered
    .filter((a) => a.type === "sql_view")
    .map((a) => a.name);
  const esc = (s: string) => s.replace(/`/g, "``");
  const deployed: Array<{ type: string; name: string; fqn: string }> = [];

  // Base SQL views first, then metric views
  for (const asset of ordered) {
    if (asset.type === "sql_view") {
      const viewBody = prepareSqlViewForDeploy(asset);
      const result = await executeStatement(
        job.warehouseId,
        `CREATE OR REPLACE VIEW \`${esc(job.catalog)}\`.\`${esc(job.devSchema)}\`.\`${esc(asset.name)}\` AS ${viewBody}`
      );
      if (result.status !== "SUCCEEDED") {
        throw new Error(
          `Failed to deploy SQL view ${asset.name}: ${result.error?.message}`
        );
      }
      deployed.push({
        type: "sql_view",
        name: asset.name,
        fqn: `${job.catalog}.${job.devSchema}.${asset.name}`,
      });
    }
  }

  for (const asset of ordered) {
    if (asset.type === "metric_view") {
      const yaml = prepareMetricViewForDeploy(
        asset,
        job.catalog,
        job.devSchema,
        sqlViewNames,
        inventory ?? job.inventory
      );
      const result = await createMetricView(
        job.warehouseId,
        job.catalog,
        job.devSchema,
        asset.name,
        yaml
      );
      if (result.status !== "SUCCEEDED") {
        throw new Error(
          `Failed to deploy metric view ${asset.name}: ${result.error?.message}`
        );
      }
      // CREATE can report success while the object is not yet queryable (wrong
      // source, UC lag, or name collision). Fail deploy early with a clear error.
      const fqn = `\`${esc(job.catalog)}\`.\`${esc(job.devSchema)}\`.\`${esc(asset.name)}\``;
      const probe = await executeStatement(
        job.warehouseId,
        `DESCRIBE TABLE EXTENDED ${fqn}`
      );
      if (probe.status !== "SUCCEEDED") {
        throw new Error(
          `Metric view ${asset.name} deployed but is not queryable (${fqn}): ${probe.error?.message ?? "DESCRIBE failed"}. Check metric-view source points at the job sql_view (e.g. *_enriched), not a colliding name.`
        );
      }
      deployed.push({
        type: "metric_view",
        name: asset.name,
        fqn: `${job.catalog}.${job.devSchema}.${asset.name}`,
      });
    }
  }

  return deployed;
}

function validateAssetsReady(assets: ProposedAsset[]): void {
  for (const asset of assets) {
    if (asset.type === "sql_view" && !asset.sql?.trim()) {
      throw new Error(`sql_view ${asset.name} is missing sql`);
    }
    if (asset.type === "metric_view" && !asset.yaml?.trim()) {
      throw new Error(`metric_view ${asset.name} is missing yaml`);
    }
  }
}

function extractFiltersFromTest(
  tc: TestCase,
  planOverride?: { filters: Record<string, string>; predicates: string[] }
): {
  filters?: Record<string, string>;
  predicates?: string[];
} {
  const fromExpression = parseLookerFilterExpression(
    tc.lookerQuery.filter_expression as string | undefined
  );

  const merged: Record<string, string> = {
    ...(tc.lookerQuery.filters && typeof tc.lookerQuery.filters === "object"
      ? (tc.lookerQuery.filters as Record<string, string>)
      : {}),
  };
  for (const [field, expr] of Object.entries(fromExpression.filters)) {
    merged[field] = merged[field] ? `${merged[field]},${expr}` : expr;
  }
  if (planOverride?.filters) {
    for (const [field, expr] of Object.entries(planOverride.filters)) {
      merged[field] = expr;
    }
  }
  const predicates = [
    ...fromExpression.predicates,
    ...(planOverride?.predicates ?? []),
  ];
  return {
    filters: Object.keys(merged).length > 0 ? merged : undefined,
    predicates: predicates.length > 0 ? predicates : undefined,
  };
}

function extractSortsFromTest(tc: TestCase): string[] | undefined {
  const sorts = tc.lookerQuery.sorts;
  if (Array.isArray(sorts)) return sorts as string[];
  return undefined;
}

function extractLimitFromTest(tc: TestCase): number {
  const limit = tc.lookerQuery.limit;
  if (typeof limit === "string") return parseInt(limit, 10) || 100;
  if (typeof limit === "number") return limit;
  return 100;
}

export async function runParityTests(params: {
  job: MigrationJobRecord;
  inventory: IntermediateRepresentation;
  assets: ProposedAsset[];
  testCases: TestCase[];
  iterationId?: string;
  fieldMapping: FieldMappingTable;
  overrides?: ReconciliationOverrides;
  /** Skill CLI default: false — results go to harness/last-run.json only. */
  persistResults?: boolean;
}): Promise<{
  passed: number;
  failed: number;
  inconclusive: number;
  evidencePasses: number;
  mandatoryPassed: number;
  mandatoryFailed: number;
  unsupportedSkipped: number;
  compileErrors: number;
  /** Databricks statement failures at run time (e.g. CAST errors) — not value mismatches. */
  sqlErrors: number;
  compilationFailures: Array<{
    name: string;
    summary: string;
    unresolvedLookerFields: string[];
    metricViewName?: string;
  }>;
  /** Sample cell diffs keyed by test name — for OpenAI diagnosis. */
  failureDiffsByTest: Map<string, unknown[]>;
  /** Rich failure evidence for diagnose (SQL, filters, mismatch kind). */
  failureEvidenceByTest: Map<string, FailureTestEvidence>;
}> {
  const {
    job,
    inventory,
    assets,
    testCases,
    iterationId,
    fieldMapping,
    overrides = emptyOverrides(),
    persistResults = false,
  } = params;

  async function maybeSaveTestResult(_payload: unknown): Promise<void> {
    // Job DB removed for skill-only mode. Hook retained for API compatibility.
    if (!persistResults) return;
    void _payload;
    void job.id;
    void iterationId;
  }

  const inventories = loadMetricViewInventories(assets);

  type ParityOne = {
    passed: number;
    failed: number;
    inconclusive: number;
    evidencePasses: number;
    mandatoryPassed: number;
    mandatoryFailed: number;
    unsupportedSkipped: number;
    compileErrors: number;
    sqlErrors: number;
    compilationFailure?: {
      name: string;
      summary: string;
      unresolvedLookerFields: string[];
      metricViewName?: string;
    };
    failureDiffs?: unknown[];
    failureEvidence?: FailureTestEvidence;
  };

  const results = await mapPool(
    testCases,
    PARITY_CONCURRENCY,
    async (tc): Promise<ParityOne> => {
      if (tc.skipStatus) {
        await maybeSaveTestResult({
          testName: tc.name,
          testType: tc.type,
          lookerQuery: tc.lookerQuery,
          status: tc.skipStatus,
          diffSummary: tc.skipReason ?? "Skipped",
          iterationId,
        });
        return {
          passed: 0,
          failed: 0,
          inconclusive: 1,
          evidencePasses: 0,
          mandatoryPassed: 0,
          mandatoryFailed: 0,
          unsupportedSkipped: tc.skipStatus === "unsupported" ? 1 : 0,
          compileErrors: 0,
          sqlErrors: 0,
        };
      }

      try {
        const lookerQuery = {
          ...(tc.lookerQuery as unknown as LookerQueryWrite),
          query_timezone:
            (tc.lookerQuery.query_timezone as string | undefined) ??
            job.timezone,
        };

        let lookerSql = tc.capturedLookerSql;
        let lookerRowSet;

        if (tc.capturedJsonBi) {
          lookerRowSet = lookerJsonBiToRowSet(
            tc.capturedJsonBi as Record<string, unknown>
          );
        } else {
          if (!lookerSql) {
            try {
              lookerSql = await getQuerySql(lookerQuery);
            } catch {
              lookerSql = undefined;
            }
          }
          const lookerResult = await runInlineQuery(lookerQuery, "json_bi");
          lookerRowSet = lookerJsonBiToRowSet(
            lookerResult as unknown as Record<string, unknown>
          );
        }

        const planOverride = resolveQueryPlanForTest(overrides, tc.name);
        const extracted = extractFiltersFromTest(tc, planOverride);
        const compiled = compileBenchmarkFromMapping({
          mapping: fieldMapping,
          inventories,
          lookerFields: tc.expectedColumns,
          filters: extracted.filters,
          predicates: extracted.predicates,
          sorts: extractSortsFromTest(tc),
          preferredMetricView: tc.metricViewName,
        });

        // Extract Databricks parameters from Looker filter_expression if they map to Databricks parameters
        const parameters: Record<string, string> = {};
        const inventory = inventories.get(compiled.metricViewName?.toLowerCase() ?? "");
        if (inventory?.parameters && extracted.filters) {
          for (const param of inventory.parameters) {
            const lookerFilterVal = extracted.filters[param.name];
            if (lookerFilterVal) {
              parameters[param.name] = lookerFilterVal;
              // Remove it from WHERE filters so it doesn't get applied twice
              delete extracted.filters[param.name];
            }
          }
        }

        if (!compiled.ok) {
          const summary = `query_compilation_error: ${formatCompilationError(compiled.issues)}`;
          const unresolved = compiled.issues
            .filter(
              (i) =>
                i.code === "unmapped_looker_field" ||
                i.code === "missing_databricks_field" ||
                i.code === "ambiguous_currency" ||
                i.code === "wrong_metric_view"
            )
            .map((i) => i.lookerField)
            .filter((f): f is string => Boolean(f));
          await maybeSaveTestResult({
            testName: tc.name,
            testType: tc.type,
            lookerQuery: tc.lookerQuery,
            lookerSql,
            lookerResult: lookerRowSet,
            status: "query_compilation_error",
            diffSummary: summary,
            iterationId,
          });
          return {
            passed: 0,
            failed: 1,
            inconclusive: 0,
            evidencePasses: 0,
            mandatoryPassed: 0,
            mandatoryFailed: tc.mandatory ? 1 : 0,
            unsupportedSkipped: 0,
            compileErrors: 1,
            sqlErrors: 0,
            compilationFailure: {
              name: tc.name,
              summary,
              unresolvedLookerFields: unresolved,
              metricViewName: compiled.metricViewName || tc.metricViewName,
            },
            failureEvidence: {
              name: tc.name,
              summary,
              status: "query_compilation_error",
              columnDiffs: [],
              unresolvedLookerFields: unresolved,
              metricViewName: compiled.metricViewName || tc.metricViewName,
              lookerSql: lookerSql,
              filterExpression: tc.lookerQuery.filter_expression as
                | string
                | undefined,
              filters: extracted.filters,
              predicates: extracted.predicates,
              lookerRowCount: lookerRowSet.rows.length,
            },
          };
        }

        const dbSql = buildMetricViewSelect({
          catalog: job.catalog,
          schema: job.devSchema,
          viewName: compiled.metricViewName,
          fields: compiled.databricksFields,
          measureNames: compiled.measureNames,
          limit: extractLimitFromTest(tc),
          filters: compiled.filters,
          predicates: compiled.predicates,
          sorts: compiled.sorts,
          parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
        });

        const dbResult = await executeStatement(job.warehouseId, dbSql);
        if (dbResult.status !== "SUCCEEDED") {
          const errSummary =
            dbResult.error?.message ?? "Databricks statement failed";
          await maybeSaveTestResult({
            testName: tc.name,
            testType: tc.type,
            lookerQuery: tc.lookerQuery,
            lookerSql,
            lookerResult: lookerRowSet,
            databricksSql: dbSql,
            status: "error",
            diffSummary: errSummary,
            iterationId,
          });
          return {
            passed: 0,
            failed: 1,
            inconclusive: 0,
            evidencePasses: 0,
            mandatoryPassed: 0,
            mandatoryFailed: tc.mandatory ? 1 : 0,
            unsupportedSkipped: 0,
            compileErrors: 0,
            sqlErrors: 1,
            failureEvidence: {
              name: tc.name,
              summary: errSummary,
              status: "error",
              columnDiffs: [],
              metricViewName: compiled.metricViewName,
              databricksSql: dbSql,
              lookerSql: lookerSql,
              filterExpression: tc.lookerQuery.filter_expression as
                | string
                | undefined,
              filters: extracted.filters,
              predicates: extracted.predicates,
              lookerRowCount: lookerRowSet.rows.length,
            },
          };
        }

        const dbRowSet = databricksResultToRowSet(
          dbResult.manifest?.schema?.columns ?? [],
          rowsFromResult(dbResult)
        );

        const columnTypes = buildColumnTypes(tc.expectedColumns, inventory);
        for (const entry of compiled.usedMappings) {
          const lookerType =
            columnTypes[entry.lookerField] ??
            columnTypes[entry.lookerField.split(".").pop() ?? ""];
          if (lookerType) {
            columnTypes[entry.databricksField] = lookerType;
          }
        }

        const compareConfig = resolveCompareConfigForTest(
          {
            decimalScale: job.decimalScale,
            timezone: job.timezone,
            requireNonEmpty: true,
          },
          overrides,
          tc.name
        );
        const comparison = compareRowSets(
          lookerRowSet,
          dbRowSet,
          columnTypes,
          compareConfig
        );

        let status:
          | "pass"
          | "pass_with_boundary_drift"
          | "fail"
          | "inconclusive";
        const out: ParityOne = {
          passed: 0,
          failed: 0,
          inconclusive: 0,
          evidencePasses: 0,
          mandatoryPassed: 0,
          mandatoryFailed: 0,
          unsupportedSkipped: 0,
          compileErrors: 0,
          sqlErrors: 0,
        };

        if (comparison.inconclusive) {
          status = "inconclusive";
          out.inconclusive = 1;
          if (tc.mandatory) out.mandatoryFailed = 1;
        } else if (comparison.match) {
          status = "pass";
          out.passed = 1;
          if (comparison.lookerRowCount > 0) out.evidencePasses = 1;
          if (tc.mandatory) out.mandatoryPassed = 1;
        } else if (comparison.boundaryDrift) {
          status = "pass_with_boundary_drift";
          out.passed = 1;
          if (comparison.lookerRowCount > 0) out.evidencePasses = 1;
          if (tc.mandatory) out.mandatoryPassed = 1;
        } else {
          status = "fail";
          out.failed = 1;
          if (tc.mandatory) out.mandatoryFailed = 1;
          out.failureDiffs = comparison.columnDiffs;
        }

        if (status === "fail" || status === "inconclusive") {
          const nullZeroDiffs = comparison.columnDiffs.filter(
            (d) =>
              d.rowIndex >= 0 &&
              isNullVsZeroMismatch(d.lookerValue, d.databricksValue)
          ).length;
          const coalesceDominant =
            comparison.measureDiffCount > 0 &&
            nullZeroDiffs > 0 &&
            nullZeroDiffs >= comparison.measureDiffCount * 0.5;

          out.failureEvidence = {
            name: tc.name,
            summary: `${comparison.plainLanguageSummary} — ${comparison.summary}`,
            status,
            columnDiffs: comparison.columnDiffs,
            metricViewName: compiled.metricViewName,
            databricksSql: dbSql,
            lookerSql: lookerSql,
            filterExpression: tc.lookerQuery.filter_expression as
              | string
              | undefined,
            filters: extracted.filters,
            predicates: extracted.predicates,
            lookerRowCount: comparison.lookerRowCount,
            databricksRowCount: comparison.databricksRowCount,
            mismatchKind:
              comparison.verdict === "mismatch"
                ? coalesceDominant
                  ? "null_vs_zero"
                  : comparison.measureDiffCount > 0
                    ? "value_mismatch"
                    : comparison.lookerRowCount !== comparison.databricksRowCount
                      ? "row_count"
                      : "mismatch"
                : comparison.verdict,
          };
        }

        await maybeSaveTestResult({
          testName: tc.name,
          testType: tc.type,
          lookerQuery: tc.lookerQuery,
          lookerSql,
          lookerResult: lookerRowSet,
          databricksSql: dbSql,
          databricksResult: dbRowSet,
          status,
          diffSummary: `${comparison.plainLanguageSummary} — ${comparison.summary} (Looker ${comparison.lookerRowCount} rows, Databricks ${comparison.databricksRowCount} rows)`,
          iterationId,
        });
        return out;
      } catch (err) {
        const summary =
          err instanceof Error ? err.message : "Test execution error";
        await maybeSaveTestResult({
          testName: tc.name,
          testType: tc.type,
          lookerQuery: tc.lookerQuery,
          status: "error",
          diffSummary: summary,
          iterationId,
        });
        return {
          passed: 0,
          failed: 1,
          inconclusive: 0,
          evidencePasses: 0,
          mandatoryPassed: 0,
          mandatoryFailed: tc.mandatory ? 1 : 0,
          unsupportedSkipped: 0,
          compileErrors: 0,
          sqlErrors: 1,
          failureEvidence: {
            name: tc.name,
            summary,
            status: "error",
            columnDiffs: [],
            filterExpression: tc.lookerQuery.filter_expression as
              | string
              | undefined,
          },
        };
      }
    }
  );

  let passed = 0;
  let failed = 0;
  let inconclusive = 0;
  let evidencePasses = 0;
  let mandatoryPassed = 0;
  let mandatoryFailed = 0;
  let unsupportedSkipped = 0;
  let compileErrors = 0;
  let sqlErrors = 0;
  const failureDiffsByTest = new Map<string, unknown[]>();
  const failureEvidenceByTest = new Map<string, FailureTestEvidence>();
  const compilationFailures: Array<{
    name: string;
    summary: string;
    unresolvedLookerFields: string[];
    metricViewName?: string;
  }> = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const tc = testCases[i];
    passed += r.passed;
    failed += r.failed;
    inconclusive += r.inconclusive;
    evidencePasses += r.evidencePasses;
    mandatoryPassed += r.mandatoryPassed;
    mandatoryFailed += r.mandatoryFailed;
    unsupportedSkipped += r.unsupportedSkipped;
    compileErrors += r.compileErrors;
    sqlErrors += r.sqlErrors;
    if (r.compilationFailure) compilationFailures.push(r.compilationFailure);
    if (r.failureDiffs) failureDiffsByTest.set(tc.name, r.failureDiffs);
    if (r.failureEvidence) {
      failureEvidenceByTest.set(tc.name, r.failureEvidence);
    }
  }

  return {
    passed,
    failed,
    inconclusive,
    evidencePasses,
    mandatoryPassed,
    mandatoryFailed,
    unsupportedSkipped,
    compileErrors,
    sqlErrors,
    compilationFailures,
    failureDiffsByTest,
    failureEvidenceByTest,
  };
}

export async function publishAssetsToProd(
  job: Pick<
    MigrationJobRecord,
    | "catalog"
    | "devSchema"
    | "prodSchema"
    | "sourceSchema"
    | "warehouseId"
    | "inventory"
  >,
  assets: ProposedAsset[]
): Promise<Array<{ type: string; name: string; fqn: string }>> {
  const prodSchema = job.prodSchema ?? job.devSchema.replace(/_dev$/, "_prod");
  assertSafeWriteSchema(prodSchema, "prod");
  assertSafeWriteSchema(job.devSchema, "dev");

  const schemaCheck = validateMigrationSchemas({
    sourceSchema: job.sourceSchema,
    devSchema: job.devSchema,
    prodSchema,
  });
  if (!schemaCheck.ok) {
    throw new Error(schemaCheck.errors.join("; "));
  }

  const prepared = assets.map((a) => ({ ...a, schema: prodSchema }));
  validateAssetsReady(prepared);

  const ordered = sortAssetsForDeploy(prepared);
  const sqlViewNames = ordered
    .filter((a) => a.type === "sql_view")
    .map((a) => a.name);
  const esc = (s: string) => s.replace(/`/g, "``");
  const published: Array<{ type: string; name: string; fqn: string }> = [];

  for (const asset of ordered) {
    if (asset.type === "sql_view") {
      const viewBody = prepareSqlViewForDeploy(asset);
      const result = await executeStatement(
        job.warehouseId,
        `CREATE OR REPLACE VIEW \`${esc(job.catalog)}\`.\`${esc(prodSchema)}\`.\`${esc(asset.name)}\` AS ${viewBody}`
      );
      if (result.status !== "SUCCEEDED") {
        throw new Error(
          `Failed to publish SQL view ${asset.name}: ${result.error?.message}`
        );
      }
      published.push({
        type: "sql_view",
        name: asset.name,
        fqn: `${job.catalog}.${prodSchema}.${asset.name}`,
      });
    }
  }

  for (const asset of ordered) {
    if (asset.type === "metric_view") {
      const yaml = prepareMetricViewForDeploy(
        asset,
        job.catalog,
        prodSchema,
        sqlViewNames,
        job.inventory
      );
      const result = await createMetricView(
        job.warehouseId,
        job.catalog,
        prodSchema,
        asset.name,
        yaml
      );
      if (result.status !== "SUCCEEDED") {
        throw new Error(
          `Failed to publish metric view ${asset.name}: ${result.error?.message}`
        );
      }
      published.push({
        type: "metric_view",
        name: asset.name,
        fqn: `${job.catalog}.${prodSchema}.${asset.name}`,
      });
    }
  }

  return published;
}
