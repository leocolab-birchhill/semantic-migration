import {
  createMetricView,
  executeStatement,
  rowsFromResult,
} from "@/lib/databricks/client";
import {
  getDashboard,
  getQuerySql,
  runInlineQuery,
  type LookerQueryWrite,
} from "@/lib/looker/client";
import {
  evaluateApprovalGate,
  withApprovalFields,
} from "@/lib/migration/approval";
import { captureLookerBenchmarks } from "@/lib/migration/baseline";
import {
  compareRowSets,
  databricksResultToRowSet,
  isNullVsZeroMismatch,
  lookerJsonBiToRowSet,
} from "@/lib/migration/comparator";
import { repairFormatIncompatibleYaml } from "@/lib/migration/agent-metadata";
import {
  inlineSiblingMetricViewRefs,
  parseUnresolvedColumnNames,
  parseUnresolvedColumnSuggestions,
  preferCadSuggestion,
  rewriteSqlUnresolvedColumns,
} from "@/lib/migration/sibling-inline";
import { mapPool } from "@/lib/migration/concurrency";
import {
  ensureMetricViewSourcesJobSqlView,
  prepareMetricViewForDeploy,
  prepareSqlViewForDeploy,
  sanitizeGeneratedAssets,
  sortAssetsForDeploy,
} from "@/lib/migration/deploy-normalize";
import { mergeDynamicFields } from "@/lib/migration/dynamic-fields";
import {
  buildDashboardInventory,
  buildExploreInventory,
  buildScopedInventory,
} from "@/lib/migration/inventory";
import {
  applyMappingTableToAssets,
  collectFieldMappings,
  compileBenchmarkFromMapping,
  formatCompilationError,
  loadMetricViewInventories,
  mergeFieldMappings,
  reconcileMappingMetricViewNames,
  repairAmbiguousCurrencyMappings,
} from "@/lib/migration/field-mapping";
import {
  claimPendingJob,
  getFinalAssetSnapshot,
  getJob,
  getLatestDeployableArtifacts,
  saveArtifact,
  saveFinalAssetSnapshot,
  saveIteration,
  saveTestResult,
  touchJobHeartbeat,
  updateJobStatus,
  type ProposedAsset,
} from "@/lib/migration/jobs";

class JobCancelledError extends Error {
  constructor(jobId: string) {
    super(`Job ${jobId} was cancelled`);
    this.name = "JobCancelledError";
  }
}
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
  applyNullZeroCoalesceRepair,
  failuresAreOnlyNullVsZero,
} from "@/lib/migration/coalesce-repair";
import {
  assertSafeWriteSchema,
  validateMigrationSchemas,
} from "@/lib/migration/schema-guard";
import { buildTestCases } from "@/lib/migration/test-cases";
import type {
  FieldMappingTable,
  IntermediateRepresentation,
  MigrationJobRecord,
  ParityReport,
  TestCase,
} from "@/lib/migration/types";
import {
  generateDatabricksAssets,
} from "@/lib/openai/client";
import { writeMigrationArtifacts } from "@/lib/migration/repo-artifacts";
import {
  buildAndSaveMigrationReport,
  formatNeedsInputMessage,
  saveJobEvent,
} from "@/lib/migration/report";

/** Keep reclaim from killing jobs mid-OpenAI / long Databricks waits. */
const HEARTBEAT_INTERVAL_MS = 60_000;
const BENCHMARK_RESUME_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PARITY_CONCURRENCY = 6;

async function assertJobNotCancelled(jobId: string): Promise<void> {
  const current = await getJob(jobId);
  if (current?.status === "cancelled") {
    throw new JobCancelledError(jobId);
  }
}

async function withHeartbeat<T>(
  jobId: string,
  work: Promise<T>
): Promise<T> {
  const t = setInterval(() => {
    void (async () => {
      try {
        await assertJobNotCancelled(jobId);
        await touchJobHeartbeat(jobId);
      } catch (err) {
        if (err instanceof JobCancelledError) return;
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  try {
    await assertJobNotCancelled(jobId);
    return await work;
  } finally {
    clearInterval(t);
  }
}

/** Reuse inventory+benchmarks captured in the last 24h after a reclaim restart. */
function freshBenchmarksFromJob(
  job: MigrationJobRecord
): IntermediateRepresentation | null {
  const inv = job.inventory;
  if (!inv?.benchmarks?.length) return null;
  const captured = inv.benchmarks[0]?.capturedAt;
  if (!captured) return null;
  const age = Date.now() - new Date(captured).getTime();
  if (Number.isNaN(age) || age < 0 || age > BENCHMARK_RESUME_MAX_AGE_MS) {
    return null;
  }
  return inv;
}

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
  iterationId: string;
  fieldMapping: FieldMappingTable;
  overrides?: ReconciliationOverrides;
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
  } = params;

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
        await saveTestResult(job.id, {
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
          await saveTestResult(job.id, {
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
        });

        const dbResult = await executeStatement(job.warehouseId, dbSql);
        if (dbResult.status !== "SUCCEEDED") {
          const errSummary =
            dbResult.error?.message ?? "Databricks statement failed";
          await saveTestResult(job.id, {
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

        await saveTestResult(job.id, {
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
        await saveTestResult(job.id, {
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

export async function processJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  const schemaCheck = validateMigrationSchemas({
    sourceSchema: job.sourceSchema,
    devSchema: job.devSchema,
    prodSchema: job.prodSchema,
  });
  if (!schemaCheck.ok) {
    await updateJobStatus(job.id, "failed", {
      errorMessage: schemaCheck.errors.join("; "),
    });
    return;
  }

  try {
    await updateJobStatus(job.id, "running", { currentPhase: "inventory" });
    await touchJobHeartbeat(job.id);

    const resumed = freshBenchmarksFromJob(job);
    let inventory: IntermediateRepresentation;

    if (resumed) {
      inventory = resumed;
      await saveJobEvent({
        jobId: job.id,
        eventType: "phase_start",
        title: "Resumed from checkpoint",
        detail: `Reusing ${inventory.benchmarks?.length ?? 0} Looker benchmarks captured ${inventory.benchmarks?.[0]?.capturedAt ?? "recently"} (skipping inventory + baseline)`,
      });
    } else {
      await saveJobEvent({
        jobId: job.id,
        eventType: "phase_start",
        title: "Started migration",
        detail: `Reading ${job.catalog}.${job.sourceSchema}.${job.sourceTable} → writing ${job.catalog}.${job.devSchema}`,
      });

      if (job.lookerSourceType === "table_scope" && job.migrationScope) {
        inventory = await buildScopedInventory(job.migrationScope);
        await updateJobStatus(job.id, "running", { inventory });
      } else if (job.lookerSourceType === "dashboard" && job.lookerDashboardId) {
        const dashboard = await getDashboard(job.lookerDashboardId);
        inventory = await buildDashboardInventory(
          dashboard.id,
          dashboard.title,
          dashboard.dashboard_elements.map((el) => ({
            id: el.id,
            title: el.title ?? undefined,
            query: el.query,
            query_id: el.query_id,
            result_maker: el.result_maker,
          }))
        );
        await updateJobStatus(job.id, "running", {
          lookerDashboardTitle: dashboard.title,
          inventory,
        });
      } else if (job.lookerModel && job.lookerExplore) {
        inventory = await buildExploreInventory(
          job.lookerModel,
          job.lookerExplore
        );
        await updateJobStatus(job.id, "running", { inventory });
      } else {
        throw new Error("Invalid Looker source configuration");
      }

      await saveArtifact(
        job.id,
        "documentation",
        "inventory",
        JSON.stringify(inventory, null, 2)
      );
      await saveJobEvent({
        jobId: job.id,
        eventType: "inventory_done",
        title: "Looker inventory captured",
        detail: `${inventory.dimensions.length} dimensions, ${inventory.measures.length} measures`,
        payload: {
          dimensions: inventory.dimensions.length,
          measures: inventory.measures.length,
        },
      });

      // Baseline: capture immutable Looker benchmarks before generation
      await updateJobStatus(job.id, "running", { currentPhase: "baseline" });
      await saveJobEvent({
        jobId: job.id,
        eventType: "phase_start",
        title: "Capturing Looker benchmarks",
      });
      if (job.lookerSourceType === "table_scope" && job.migrationScope) {
        const benchmarks = await withHeartbeat(
          job.id,
          captureLookerBenchmarks(job.migrationScope, job.timezone)
        );
        inventory = {
          ...inventory,
          benchmarks,
          dynamicFields: mergeDynamicFields(
            inventory.dynamicFields,
            benchmarks.flatMap((b) => b.dynamicFields ?? [])
          ),
        };
        await updateJobStatus(job.id, "running", { inventory });
        await saveArtifact(
          job.id,
          "documentation",
          "looker_benchmarks",
          JSON.stringify(benchmarks, null, 2)
        );
      } else if (inventory.tileQueries.length > 0) {
        const syntheticScope = {
          sourceTable: {
            catalog: job.catalog,
            schema: job.sourceSchema,
            table: job.sourceTable,
          },
          explores: [
            {
              model: inventory.source.model,
              explore: inventory.source.explore,
            },
          ],
          tiles: inventory.tileQueries.map((t) => ({
            id: t.id,
            title: t.title,
            model: t.model,
            explore: t.explore,
            sourceKind: (t.sourceKind ?? "dashboard_tile") as
              | "look"
              | "dashboard_tile",
            dashboardId: t.dashboardId,
            dashboardTitle: t.dashboardTitle,
            lookId: t.lookId,
            fields: t.fields,
            filters: t.filters,
            filterExpression: t.filterExpression,
            sorts: t.sorts,
            limit: t.limit,
            pivots: t.pivots,
            total: t.total,
            timezone: t.timezone,
            confidence: "high" as const,
            evidence: [],
            role: "validation_benchmark" as const,
            dynamicFields: t.dynamicFields,
          })),
          views: [],
        };
        const benchmarks = await withHeartbeat(
          job.id,
          captureLookerBenchmarks(syntheticScope, job.timezone)
        );
        inventory = {
          ...inventory,
          benchmarks,
          dynamicFields: mergeDynamicFields(
            inventory.dynamicFields,
            benchmarks.flatMap((b) => b.dynamicFields ?? [])
          ),
        };
        await updateJobStatus(job.id, "running", { inventory });
        await saveArtifact(
          job.id,
          "documentation",
          "looker_benchmarks",
          JSON.stringify(benchmarks, null, 2)
        );
      }
    }

    const testCases = buildTestCases(inventory, {
      benchmarks: inventory.benchmarks,
    });
    await saveJobEvent({
      jobId: job.id,
      eventType: resumed ? "phase_start" : "baseline_done",
      title: resumed
        ? "Continuing migration"
        : "Looker benchmarks ready",
      detail: resumed
        ? `${testCases.length} test cases from checkpoint`
        : `${inventory.benchmarks?.length ?? 0} tile benchmarks, ${testCases.length} test cases`,
      payload: {
        benchmarks: inventory.benchmarks?.length ?? 0,
        testCases: testCases.length,
        resumed: Boolean(resumed),
      },
    });
    let assets: ProposedAsset[] = [];
    let fieldMapping: FieldMappingTable = inventory.fieldMapping ?? {
      version: "1.0",
      entries: [],
      updatedAt: new Date().toISOString(),
    };
    let generationRationale = "";
    let iteration = 0;
    let allPassed = false;
    let lastEvidencePasses = 0;
    let lastPassed = 0;
    let lastFailed = 0;
    let lastInconclusive = 0;
    let lastMandatoryPassed = 0;
    let lastMandatoryFailed = 0;
    let lastCompileErrors = 0;
    let lastSqlErrors = 0;
    let reconciliationOverrides: ReconciliationOverrides = emptyOverrides();
    /** Redeploy only when SQL/YAML/mapping assets changed; plan/compare overrides apply in-memory. */
    let needsRedeploy = true;

    while (iteration < job.maxIterations && !allPassed) {
      await assertJobNotCancelled(job.id);
      iteration++;
      await touchJobHeartbeat(job.id);
      await updateJobStatus(job.id, "running", {
        currentPhase: iteration === 1 ? "generate" : "patch",
        iterationCount: iteration,
      });

      if (iteration === 1) {
        const generated = await withHeartbeat(
          job.id,
          generateDatabricksAssets({
            inventory,
            catalog: job.catalog,
            sourceSchema: job.sourceSchema,
            sourceTable: job.sourceTable,
            devSchema: job.devSchema,
          })
        );
        generationRationale = generated.rationale;
        assets = sanitizeGeneratedAssets(
          generated.assets,
          job.catalog,
          job.devSchema,
          inventory
        );
        fieldMapping = mergeFieldMappings(
          fieldMapping,
          collectFieldMappings(assets, inventory)
        );
        fieldMapping = reconcileMappingMetricViewNames(fieldMapping, assets);
        fieldMapping = repairAmbiguousCurrencyMappings(fieldMapping, inventory);
        assets = applyMappingTableToAssets(assets, fieldMapping);
        // Re-sanitize so agent metadata uses the reconciled field mapping.
        assets = sanitizeGeneratedAssets(
          assets,
          job.catalog,
          job.devSchema,
          { ...inventory, fieldMapping }
        );
        inventory = { ...inventory, fieldMapping };
        await saveArtifact(
          job.id,
          "documentation",
          "field_mapping",
          JSON.stringify(fieldMapping, null, 2)
        );
        await saveJobEvent({
          jobId: job.id,
          eventType: "generate_done",
          title: "Generated Databricks assets",
          iterationNumber: iteration,
          detail: `${assets.length} asset(s): ${assets.map((a) => a.name).join(", ")}`,
          payload: {
            assets: assets.map((a) => ({ type: a.type, name: a.name })),
          },
        });
        // Persist OpenAI one-shot draft into migrations/<table>/ for local Cursor fixes.
        const written = writeMigrationArtifacts({
          catalog: job.catalog,
          sourceSchema: job.sourceSchema,
          sourceTable: job.sourceTable,
          devSchema: job.devSchema,
          warehouseId: job.warehouseId,
          databricksHost: job.databricksHost,
          decimalScale: job.decimalScale,
          timezone: job.timezone,
          jobId: job.id,
          scope: job.migrationScope,
          inventory: { ...inventory, fieldMapping },
          assets,
          fieldMapping,
        });
        await saveJobEvent({
          jobId: job.id,
          eventType: "info",
          title: "Wrote migration draft artifacts",
          iterationNumber: iteration,
          detail: written.root,
          payload: { tableKey: written.tableKey, root: written.root },
        });
        needsRedeploy = true;
      }

      validateAssetsReady(assets);

      if (needsRedeploy) {
        await updateJobStatus(job.id, "running", { currentPhase: "deploy_dev" });
        await saveJobEvent({
          jobId: job.id,
          eventType: "phase_start",
          title: `Deploying to ${job.catalog}.${job.devSchema}`,
          iterationNumber: iteration,
        });
        try {
          const deployed = await withHeartbeat(
            job.id,
            deployAssetsToDev(job, assets, inventory)
          );
          await saveJobEvent({
            jobId: job.id,
            eventType: "deploy_done",
            title: "Wrote objects to Databricks",
            iterationNumber: iteration,
            detail: deployed.map((d) => d.fqn).join(", "),
            payload: { objects: deployed },
          });
          needsRedeploy = false;
        } catch (error) {
          const deploymentError =
            error instanceof Error ? error.message : "Unknown deployment error";
          await saveJobEvent({
            jobId: job.id,
            eventType: "deploy_failed",
            title: "Databricks deploy failed",
            iterationNumber: iteration,
            detail: deploymentError,
          });

          // Deterministic fix for format↔type mismatches before calling OpenAI.
          if (
            /COLUMN_FORMAT_INCOMPATIBLE_WITH_COLUMN_TYPE/i.test(deploymentError)
          ) {
            const strippedNames: string[] = [];
            assets = assets.map((asset) => {
              if (asset.type !== "metric_view" || !asset.yaml?.trim()) {
                return asset;
              }
              const repaired = repairFormatIncompatibleYaml(
                asset.yaml,
                deploymentError,
                inventory,
                asset.fieldMappings ?? fieldMapping.entries
              );
              if (repaired.stripped.length === 0) return asset;
              strippedNames.push(
                ...repaired.stripped.map((n) => `${asset.name}.${n}`)
              );
              return { ...asset, yaml: repaired.yaml };
            });
            if (strippedNames.length > 0) {
              assets = sanitizeGeneratedAssets(
                assets,
                job.catalog,
                job.devSchema,
                inventory
              );
              // Sanitize/enrich must not re-attach formats named in the error.
              assets = assets.map((asset) => {
                if (asset.type !== "metric_view" || !asset.yaml?.trim()) {
                  return asset;
                }
                const again = repairFormatIncompatibleYaml(
                  asset.yaml,
                  deploymentError,
                  inventory,
                  asset.fieldMappings ?? fieldMapping.entries
                );
                return again.stripped.length > 0
                  ? { ...asset, yaml: again.yaml }
                  : asset;
              });
              await saveJobEvent({
                jobId: job.id,
                eventType: "info",
                title: "Stripped incompatible numeric formats from string fields",
                iterationNumber: iteration,
                detail: strippedNames.join(", "),
                payload: { stripped: strippedNames },
              });
              needsRedeploy = true;
              generationRationale = `Removed incompatible formats: ${strippedNames.join(", ")}`;
              continue;
            }
          }

          // Missing physical columns (often Looker currency stems → *_cad).
          // Rewrite sql_view SQL from Databricks "Did you mean" before sibling-inline.
          if (/UNRESOLVED_COLUMN/i.test(deploymentError)) {
            const unresolved = parseUnresolvedColumnNames(deploymentError);
            const suggestions = parseUnresolvedColumnSuggestions(deploymentError);
            const preferred = preferCadSuggestion(suggestions);
            const replacements =
              unresolved.length > 0 && preferred
                ? unresolved.map((from) => ({ from, to: preferred }))
                : [];

            if (replacements.length > 0) {
              let sqlChanged = false;
              const sqlDetails: string[] = [];
              assets = assets.map((asset) => {
                if (asset.type !== "sql_view" || !asset.sql?.trim()) {
                  return asset;
                }
                const rewritten = rewriteSqlUnresolvedColumns(
                  asset.sql,
                  replacements
                );
                if (rewritten.replaced.length === 0) return asset;
                sqlChanged = true;
                sqlDetails.push(
                  ...rewritten.replaced.map(
                    (r) => `${asset.name}:${r.from}→${r.to}`
                  )
                );
                return { ...asset, sql: rewritten.sql };
              });
              if (sqlChanged) {
                assets = sanitizeGeneratedAssets(
                  assets,
                  job.catalog,
                  job.devSchema,
                  inventory
                );
                await saveJobEvent({
                  jobId: job.id,
                  eventType: "info",
                  title: "Rewrote unresolved SQL columns from Databricks suggestions",
                  iterationNumber: iteration,
                  detail: sqlDetails.slice(0, 30).join("; "),
                  payload: { replacements: sqlDetails, unresolved, suggestions },
                });
                needsRedeploy = true;
                generationRationale = `Rewrote SQL columns after UNRESOLVED_COLUMN (${sqlDetails.join(", ")})`;
                continue;
              }
            }

            // Sibling dimension refs (Looker ${view.other_dim}) — Databricks only
            // resolves exprs against the source relation. Targeted only — never
            // full-pass when parse failed (would mutate unrelated measures).
            const siblingTargets = unresolved.filter(
              (n) => n.length > 1 && !/^[a-z]$/i.test(n)
            );
            if (siblingTargets.length > 0) {
              let changed = false;
              const details: string[] = [];
              assets = assets.map((asset) => {
                if (asset.type !== "metric_view" || !asset.yaml?.trim()) {
                  return asset;
                }
                const result = inlineSiblingMetricViewRefs(
                  asset.yaml,
                  siblingTargets
                );
                if (result.inlined.length === 0) return asset;
                changed = true;
                details.push(
                  ...result.inlined.map(
                    (i) => `${asset.name}.${i.field}←${i.usedSibling}`
                  )
                );
                return { ...asset, yaml: result.yaml };
              });
              if (changed) {
                assets = sanitizeGeneratedAssets(
                  assets,
                  job.catalog,
                  job.devSchema,
                  inventory
                );
                await saveJobEvent({
                  jobId: job.id,
                  eventType: "info",
                  title: "Inlined sibling dimension refs in metric-view exprs",
                  iterationNumber: iteration,
                  detail: details.slice(0, 30).join("; "),
                  payload: { inlined: details.slice(0, 50), unresolved },
                });
                needsRedeploy = true;
                generationRationale = `Inlined sibling dim refs after UNRESOLVED_COLUMN (${siblingTargets.join(", ")})`;
                continue;
              }
            }
          }

          // Metric view missing / not queryable — usually source not pointed at
          // the job sql_view (or name collision with the metric view itself).
          if (
            /TABLE_OR_VIEW_NOT_FOUND|not queryable|METRIC_VIEW/i.test(
              deploymentError
            )
          ) {
            const sqlViewNames = assets
              .filter((a) => a.type === "sql_view")
              .map((a) => a.name);
            if (sqlViewNames.length > 0) {
              let changed = false;
              const sources: string[] = [];
              assets = assets.map((asset) => {
                if (asset.type !== "metric_view" || !asset.yaml?.trim()) {
                  return asset;
                }
                const ensured = ensureMetricViewSourcesJobSqlView(
                  asset.yaml,
                  job.catalog,
                  job.devSchema,
                  sqlViewNames
                );
                if (!ensured.changed) return asset;
                changed = true;
                if (ensured.source) sources.push(`${asset.name}→${ensured.source}`);
                return { ...asset, yaml: ensured.yaml };
              });
              if (changed) {
                assets = sanitizeGeneratedAssets(
                  assets,
                  job.catalog,
                  job.devSchema,
                  inventory
                );
                await saveJobEvent({
                  jobId: job.id,
                  eventType: "info",
                  title: "Repointed metric-view source to job SQL view",
                  iterationNumber: iteration,
                  detail: sources.join("; "),
                  payload: { sources },
                });
                needsRedeploy = true;
                generationRationale = `Repointed metric-view source(s) to job sql_view after: ${deploymentError.slice(0, 180)}`;
                continue;
              }
            }
          }

          // OpenAI diagnose removed: after deterministic deploy repairs fail,
          // pause for local Cursor fix against Databricks CLI feedback.
          const pauseReason = `Deploy failed — fix draft assets locally: ${deploymentError}`;
          writeMigrationArtifacts({
            catalog: job.catalog,
            sourceSchema: job.sourceSchema,
            sourceTable: job.sourceTable,
            devSchema: job.devSchema,
            warehouseId: job.warehouseId,
            databricksHost: job.databricksHost,
            decimalScale: job.decimalScale,
            timezone: job.timezone,
            jobId: job.id,
            scope: job.migrationScope,
            inventory,
            assets,
            fieldMapping,
            pauseReason,
          });
          const report = await buildAndSaveMigrationReport({
            job,
            assets,
            diagnosis: pauseReason,
            pauseReason,
            statusOverride: "needs_input",
          });
          await saveJobEvent({
            jobId: job.id,
            eventType: "needs_input",
            title: "Paused — needs local Cursor fix (deploy)",
            iterationNumber: iteration,
            detail: formatNeedsInputMessage(report),
            payload: {
              mode: "local_cursor_fix",
              deploymentError,
              hint: "npm run cli:deploy / cli:parity after editing migrations/<table>/draft/",
            },
          });
          await updateJobStatus(job.id, "needs_input", {
            currentPhase: "deploy_dev",
            errorMessage: formatNeedsInputMessage(report),
          });
          return;
        }
      } else {
        await saveJobEvent({
          jobId: job.id,
          eventType: "info",
          title: "Skipped Databricks redeploy",
          iterationNumber: iteration,
          detail:
            "Only query-plan / compare overrides changed — retesting against existing deployed assets.",
        });
      }

      const iterationId = await saveIteration(job.id, iteration, {
        phase: "test",
        rationale: generationRationale,
        testsRun: testCases.length,
        testsPassed: 0,
        testsFailed: 0,
      });
      await saveFinalAssetSnapshot(job.id, assets, iterationId);

      await updateJobStatus(job.id, "running", { currentPhase: "test" });
      fieldMapping = repairAmbiguousCurrencyMappings(fieldMapping, inventory);
      assets = applyMappingTableToAssets(assets, fieldMapping);
      inventory = { ...inventory, fieldMapping };
      const results = await withHeartbeat(
        job.id,
        runParityTests({
          job,
          inventory,
          assets,
          testCases,
          iterationId,
          fieldMapping,
          overrides: reconciliationOverrides,
        })
      );
      await saveJobEvent({
        jobId: job.id,
        eventType: "test_summary",
        title: `Iteration ${iteration} tests`,
        iterationNumber: iteration,
        detail: `${results.passed} pass, ${results.failed} fail, ${results.inconclusive} inconclusive/unsupported`,
        payload: {
          passed: results.passed,
          failed: results.failed,
          inconclusive: results.inconclusive,
          mandatoryPassed: results.mandatoryPassed,
          mandatoryFailed: results.mandatoryFailed,
          queryPlanPatches: reconciliationOverrides.queryPlanPatches.length,
          comparePatches: reconciliationOverrides.comparePatches.length,
        },
      });

      lastPassed = results.passed;
      lastFailed = results.failed;
      lastInconclusive = results.inconclusive;
      lastEvidencePasses = results.evidencePasses;
      lastMandatoryPassed = results.mandatoryPassed;
      lastMandatoryFailed = results.mandatoryFailed;
      lastCompileErrors = results.compileErrors;
      lastSqlErrors = results.sqlErrors;

      const gate = evaluateApprovalGate({
        mandatoryTests: testCases.filter((t) => t.mandatory),
        mandatoryPassed: results.mandatoryPassed,
        mandatoryFailed: results.mandatoryFailed,
        evidencePasses: results.evidencePasses,
        failed: results.failed,
        unsupportedCount: results.unsupportedSkipped,
        compileErrorCount: results.compileErrors,
        sqlErrorCount: results.sqlErrors,
      });
      allPassed = gate.canApprove;

      if (!allPassed && iteration < job.maxIterations) {
        await touchJobHeartbeat(job.id);

        const mandatoryByName = new Map(
          testCases.map((tc) => [tc.name, tc.mandatory])
        );

        const failedEvidence: FailureTestEvidence[] = [
          ...results.compilationFailures.map((c) => {
            const fromMap = results.failureEvidenceByTest.get(c.name);
            return (
              fromMap ?? {
                name: c.name,
                summary: c.summary,
                columnDiffs: [],
                status: "query_compilation_error",
                unresolvedLookerFields: c.unresolvedLookerFields,
                metricViewName: c.metricViewName,
              }
            );
          }),
          ...[...results.failureEvidenceByTest.values()].filter(
            (e) => e.status !== "query_compilation_error"
          ),
        ].map((e) => ({
          ...e,
          mandatory: mandatoryByName.get(e.name) ?? false,
        }));

        // Deterministic Looker-0 vs Databricks-null fix (no OpenAI).
        const coalesceRepair = applyNullZeroCoalesceRepair(
          assets,
          failedEvidence
        );
        if (coalesceRepair.patchedMeasures.length > 0) {
          assets = sanitizeGeneratedAssets(
            coalesceRepair.assets,
            job.catalog,
            job.devSchema,
            inventory
          );
          await saveJobEvent({
            jobId: job.id,
            eventType: "info",
            title: "Applied COALESCE(…, 0) for null↔0 measure gaps",
            iterationNumber: iteration,
            detail: `Wrapped measures: ${coalesceRepair.patchedMeasures.join(", ")}`,
            payload: { measures: coalesceRepair.patchedMeasures },
          });
          await saveFinalAssetSnapshot(job.id, assets, iterationId);

          if (failuresAreOnlyNullVsZero(failedEvidence)) {
            needsRedeploy = true;
            generationRationale = `Deterministic COALESCE(expr, 0) on ${coalesceRepair.patchedMeasures.join(", ")} for Looker 0 vs Databricks null`;
            continue;
          }
        }

        // Deterministic TABLE_OR_VIEW_NOT_FOUND → repoint source, no OpenAI.
        const notFoundDefect = failedEvidence.some((e) =>
          /TABLE_OR_VIEW_NOT_FOUND/i.test(e.summary ?? "")
        );
        if (notFoundDefect) {
          const sqlViewNames = assets
            .filter((a) => a.type === "sql_view")
            .map((a) => a.name);
          let changed = false;
          if (sqlViewNames.length > 0) {
            assets = assets.map((asset) => {
              if (asset.type !== "metric_view" || !asset.yaml?.trim()) {
                return asset;
              }
              const ensured = ensureMetricViewSourcesJobSqlView(
                asset.yaml,
                job.catalog,
                job.devSchema,
                sqlViewNames
              );
              if (!ensured.changed) return asset;
              changed = true;
              return { ...asset, yaml: ensured.yaml };
            });
          }
          if (changed) {
            assets = sanitizeGeneratedAssets(
              assets,
              job.catalog,
              job.devSchema,
              inventory
            );
            await saveJobEvent({
              jobId: job.id,
              eventType: "info",
              title: "Repointed metric-view source after TABLE_OR_VIEW_NOT_FOUND",
              iterationNumber: iteration,
              detail: "Redeploying with job sql_view source.",
            });
            needsRedeploy = true;
            generationRationale =
              "Repointed metric-view source to job sql_view after TABLE_OR_VIEW_NOT_FOUND";
            continue;
          }
        }

        // OpenAI diagnose removed: pause for local Cursor fix loop.
        const pauseReason =
          `Parity failed (${results.mandatoryFailed} mandatory tile(s)). ` +
          `OpenAI draft is frozen — fix migrations/<table>/draft/ locally, then ` +
          `npm run cli:deploy && npm run cli:parity.`;
        writeMigrationArtifacts({
          catalog: job.catalog,
          sourceSchema: job.sourceSchema,
          sourceTable: job.sourceTable,
          devSchema: job.devSchema,
          warehouseId: job.warehouseId,
          databricksHost: job.databricksHost,
          decimalScale: job.decimalScale,
          timezone: job.timezone,
          jobId: job.id,
          scope: job.migrationScope,
          inventory,
          assets,
          fieldMapping,
          pauseReason,
        });
        const report = await buildAndSaveMigrationReport({
          job,
          assets,
          diagnosis: pauseReason,
          pauseReason,
          statusOverride: "needs_input",
        });
        await saveIteration(job.id, iteration, {
          phase: "test",
          diagnosis: pauseReason,
          testsRun: testCases.length,
          testsPassed: results.passed,
          testsFailed: results.failed,
          needsHumanInput: true,
        });
        await saveJobEvent({
          jobId: job.id,
          eventType: "needs_input",
          title: "Paused — needs local Cursor fix (parity)",
          iterationNumber: iteration,
          detail: formatNeedsInputMessage(report),
          payload: {
            mode: "local_cursor_fix",
            mandatoryFailed: results.mandatoryFailed,
            failed: results.failed,
            failedTests: failedEvidence.slice(0, 30).map((e) => ({
              name: e.name,
              summary: e.summary?.slice(0, 300),
              status: e.status,
            })),
          },
        });
        await updateJobStatus(job.id, "needs_input", {
          currentPhase: "test",
          errorMessage: formatNeedsInputMessage(report),
        });
        return;
      }
    }

    const finalGate = evaluateApprovalGate({
      mandatoryTests: testCases.filter((t) => t.mandatory),
      mandatoryPassed: lastMandatoryPassed,
      mandatoryFailed: lastMandatoryFailed,
      evidencePasses: lastEvidencePasses,
      failed: lastFailed,
      unsupportedCount: testCases.filter((t) => t.skipStatus === "unsupported")
        .length,
      compileErrorCount: lastCompileErrors,
      sqlErrorCount: lastSqlErrors,
    });

    let parityReport: ParityReport = {
      objectsCreated: assets.map((a) => ({
        type: a.type,
        name: a.name,
        schema: job.devSchema,
      })),
      measuresTranslated: (fieldMapping.entries.length
        ? fieldMapping.entries
            .filter((e) => e.kind === "measure")
            .map((e) => ({
              looker: e.lookerField,
              databricks: e.databricksField,
              notes: [
                e.currency && `currency=${e.currency}`,
                e.unit && `unit=${e.unit}`,
                e.populationGrain && `grain=${e.populationGrain}`,
                `metric_view=${e.metricViewName}`,
              ]
                .filter(Boolean)
                .join("; "),
            }))
        : inventory.measures.map((m) => ({
            looker: m.name,
            databricks: m.name,
          }))),
      intentionalDifferences: [],
      multipleViewDecisions: assets
        .filter((a) => a.type === "metric_view")
        .map((a) => `${a.name}: ${a.description}`),
      securityMappings: [],
      unsupportedLookerFeatures: inventory.unsupportedFeatures,
      testsPassed: lastPassed,
      testsFailed: lastFailed,
      testsInconclusive: lastInconclusive,
      generatedAt: new Date().toISOString(),
    };

    parityReport = withApprovalFields(parityReport, finalGate, {
      passed: lastMandatoryPassed,
      failed: lastMandatoryFailed,
      count: testCases.filter((t) => t.mandatory && !t.skipStatus).length,
    });

    if (finalGate.canApprove) {
      validateAssetsReady(assets);
      await saveFinalAssetSnapshot(job.id, assets);
      await updateJobStatus(job.id, "awaiting_approval", {
        currentPhase: "awaiting_approval",
        parityReport,
        errorMessage: null,
      });
      await saveArtifact(
        job.id,
        "documentation",
        "parity_report",
        JSON.stringify(parityReport, null, 2)
      );
      await buildAndSaveMigrationReport({
        job: { ...job, status: "awaiting_approval", parityReport },
        assets,
        pauseReason: null,
        statusOverride: "awaiting_approval",
      });
      await saveJobEvent({
        jobId: job.id,
        eventType: "awaiting_approval",
        title: "Ready for approval",
        detail: `${lastPassed} tests passed — review and approve to publish`,
      });
    } else {
      const failReason =
        finalGate.blockedReason ??
        `Reconciliation failed after ${iteration} iterations (${lastFailed} failed, ${lastInconclusive} inconclusive)`;
      await updateJobStatus(job.id, "failed", {
        currentPhase: "compare",
        parityReport,
        errorMessage: failReason,
      });
      await buildAndSaveMigrationReport({
        job: { ...job, status: "failed", parityReport, errorMessage: failReason },
        assets,
        pauseReason: failReason,
        statusOverride: "failed",
      });
      await saveJobEvent({
        jobId: job.id,
        eventType: "failed",
        title: "Migration failed",
        detail: failReason,
      });
    }
  } catch (err) {
    if (err instanceof JobCancelledError) {
      await saveJobEvent({
        jobId: job.id,
        eventType: "info",
        title: "Migration cancelled",
        detail: "Stopped by user or abandoned after stale heartbeat",
      }).catch(() => undefined);
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    await saveJobEvent({
      jobId: job.id,
      eventType: "failed",
      title: "Migration crashed",
      detail: message,
    }).catch(() => undefined);
    try {
      const snapshot = await getFinalAssetSnapshot(job.id);
      await buildAndSaveMigrationReport({
        job: { ...job, status: "failed", errorMessage: message },
        assets: snapshot ?? [],
        pauseReason: message,
        statusOverride: "failed",
      });
    } catch {
      // best-effort report
    }
    // Don't overwrite an explicit cancel that raced with this failure.
    const latest = await getJob(job.id).catch(() => null);
    if (latest?.status === "cancelled") return;
    await updateJobStatus(job.id, "failed", {
      errorMessage: message,
    });
    throw err;
  }
}

export async function publishApprovedJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) throw new Error("Job not found");
  if (job.status !== "approved") {
    throw new Error("Job must be approved before publishing");
  }

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

  let assets = await getFinalAssetSnapshot(jobId);
  if (!assets || assets.length === 0) {
    const allowed = new Set(
      (job.parityReport?.objectsCreated ?? []).map((o) => o.name)
    );
    const rows = await getLatestDeployableArtifacts(
      jobId,
      allowed.size ? allowed : undefined
    );
    assets = rows.map((row) =>
      row.artifact_type === "yaml"
        ? {
            type: "metric_view" as const,
            name: row.name,
            schema: prodSchema,
            description: "",
            yaml: row.content,
          }
        : {
            type: "sql_view" as const,
            name: row.name,
            schema: prodSchema,
            description: "",
            sql: row.content,
          }
    );
  }

  assets = assets.map((a) => ({ ...a, schema: prodSchema }));
  validateAssetsReady(assets);

  const ordered = sortAssetsForDeploy(assets);
  const sqlViewNames = ordered
    .filter((a) => a.type === "sql_view")
    .map((a) => a.name);
  const esc = (s: string) => s.replace(/`/g, "``");

  try {
    await updateJobStatus(jobId, "approved", {
      currentPhase: "publish",
      errorMessage: null,
    });

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
      }
    }

    await updateJobStatus(jobId, "published", {
      currentPhase: "complete",
      publishedAt: true,
      errorMessage: null,
    });
    await saveJobEvent({
      jobId,
      eventType: "published",
      title: "Published to production",
      detail: assets
        .map((a) => `${job.catalog}.${prodSchema}.${a.name}`)
        .join(", "),
    });
  } catch (err) {
    await updateJobStatus(jobId, "approved", {
      currentPhase: "awaiting_approval",
      errorMessage:
        err instanceof Error
          ? `Publish failed (job remains approved): ${err.message}`
          : "Publish failed (job remains approved)",
    });
    throw err;
  }
}

export async function runWorkerLoop(): Promise<void> {
  for (;;) {
    const job = await claimPendingJob();
    if (!job) return;
    await processJob(job.id);
  }
}

