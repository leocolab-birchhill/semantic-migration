"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConfirmedMigrationScope,
  DiscoveredExplore,
  DiscoveredTile,
  DiscoveredView,
  MigrationJobRecord,
  TableDiscoveryResult,
} from "@/lib/migration/types";
import {
  DEFAULT_DEV_SCHEMA,
  DEFAULT_PROD_SCHEMA,
  validateMigrationSchemas,
} from "@/lib/migration/schema-guard";
import {
  loadWizardState,
  patchWizardState,
  wizardSourceKey,
  type WizardStep,
} from "@/lib/migration/wizard-persistence";
import type {
  MigrationEvent,
  MigrationReport,
} from "@/lib/migration/report";
import { JobActivityPanel } from "@/components/JobActivityPanel";
import { ParityScorecard } from "@/components/ParityScorecard";

function newIdempotencyKey(prefix = "job"): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toJobDetail(data: {
  iterations?: JobDetail["iterations"];
  tests?: TestRow[];
  artifacts?: JobDetail["artifacts"];
  events?: MigrationEvent[];
  migrationReport?: MigrationReport | null;
}): JobDetail {
  return {
    iterations: data.iterations ?? [],
    tests: (data.tests ?? []) as TestRow[],
    artifacts: data.artifacts ?? [],
    events: data.events ?? [],
    migrationReport: data.migrationReport ?? null,
  };
}

interface MigrationPanelProps {
  authenticated: boolean;
  connectedHost: string | null;
  lookerSelection: LookerSelection | null;
  databricksSelection: DatabricksSelection | null;
  onRestoreSelections?: (payload: {
    looker: LookerSelection;
    databricks: DatabricksSelection;
    prodSchema?: string | null;
  }) => void;
  onDatabricksSelectionChange?: (selection: DatabricksSelection) => void;
}

export interface LookerSelection {
  type: "explore" | "dashboard";
  model?: string;
  explore?: string;
  dashboardId?: string;
  dashboardTitle?: string;
  label: string;
}

export interface DatabricksSelection {
  warehouseId: string;
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
  destSchema: string;
  prodSchema?: string;
}

interface TestRow {
  test_name: string;
  status: string;
  diff_summary: string;
  iteration_id?: string | null;
  looker_result?: unknown;
  databricks_result?: unknown;
  looker_query?: unknown;
}

interface JobDetail {
  iterations: Array<{
    iteration_number?: number;
    phase?: string;
    diagnosis?: string | null;
    tests_passed?: number;
    tests_failed?: number;
    needs_human_input?: boolean;
  }>;
  tests: TestRow[];
  artifacts: Array<{ artifact_type?: string; name?: string }>;
  events: MigrationEvent[];
  migrationReport: MigrationReport | null;
}

interface WorkerStatusSnapshot {
  databaseOk: boolean;
  databaseError?: string;
  workerLikelyUp: boolean;
  runningJobs: number;
  hint?: string;
  activeJob?: {
    secondsSinceHeartbeat: number | null;
    heartbeatWarning: boolean;
    heartbeatStale: boolean;
    reclaimed: boolean;
  };
}

export function MigrationPanel({
  authenticated,
  connectedHost,
  lookerSelection,
  databricksSelection,
  onRestoreSelections,
  onDatabricksSelectionChange,
}: MigrationPanelProps) {
  const hydratedRef = useRef(false);
  const [jobs, setJobs] = useState<MigrationJobRecord[]>([]);
  const [activeJob, setActiveJob] = useState<MigrationJobRecord | null>(null);
  const [jobDetail, setJobDetail] = useState<JobDetail | null>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatusSnapshot | null>(
    null
  );
  const [dbConfigured, setDbConfigured] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workerMessage, setWorkerMessage] = useState<string | null>(null);
  const [restoredNotice, setRestoredNotice] = useState<string | null>(null);
  const submittingRef = useRef(false);

  // Lazy-init from sessionStorage so HMR / next.config restarts don't wipe progress
  const [step, setStep] = useState<WizardStep>(() => {
    const saved = loadWizardState();
    if (saved?.discovery) {
      return saved.step === "source" ? "discover" : saved.step;
    }
    return saved?.step ?? "source";
  });
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<TableDiscoveryResult | null>(
    () => loadWizardState()?.discovery ?? null
  );
  const [selectedExplores, setSelectedExplores] = useState<Set<string>>(
    () => new Set(loadWizardState()?.selectedExplores ?? [])
  );
  const [selectedTiles, setSelectedTiles] = useState<Set<string>>(
    () => new Set(loadWizardState()?.selectedTiles ?? [])
  );
  const [devSchema, setDevSchema] = useState(
    () => loadWizardState()?.devSchema || DEFAULT_DEV_SCHEMA
  );
  const [prodSchema, setProdSchema] = useState(
    () => loadWizardState()?.prodSchema || DEFAULT_PROD_SCHEMA
  );
  const [legacyMode, setLegacyMode] = useState(false);
  const [pendingJobId] = useState<string | null>(
    () => loadWizardState()?.activeJobId ?? null
  );

  const refreshJobs = useCallback(() => {
    fetch("/api/migrations")
      .then((r) => r.json())
      .then((data) => {
        setJobs(data.jobs ?? []);
        setDbConfigured(data.dbConfigured !== false);
      })
      .catch(() => {});
  }, []);

  // Rehydrate active job + show notice once after mount
  useEffect(() => {
    refreshJobs();
    const saved = loadWizardState();
    if (saved?.discovery || saved?.activeJobId) {
      setRestoredNotice(
        saved.activeJobId
          ? "Restored your migration progress after a page reload."
          : "Restored discovery results after a page reload. Confirm scope and continue."
      );
    }
    const jobId = pendingJobId;
    if (!jobId) return;
    fetch(`/api/migrations/${jobId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.job) {
          setActiveJob(data.job);
          setJobDetail(toJobDetail(data));
        }
      })
      .catch(() => {});
  }, [refreshJobs, pendingJobId]);

  // Mark hydrated after first paint so we don't persist empty state over storage
  useEffect(() => {
    hydratedRef.current = true;
  }, []);

  // Persist wizard state whenever it changes so remounts don't wipe progress
  useEffect(() => {
    if (!hydratedRef.current) return;
    const sourceKey = databricksSelection
      ? wizardSourceKey(databricksSelection)
      : discovery
        ? `${discovery.catalog}.${discovery.schema}.${discovery.table}`
        : null;
    patchWizardState({
      step,
      discovery,
      selectedExplores: Array.from(selectedExplores),
      selectedTiles: Array.from(selectedTiles),
      activeJobId: activeJob?.id ?? pendingJobId,
      devSchema,
      prodSchema,
      sourceKey,
      databricks: databricksSelection
        ? {
            warehouseId: databricksSelection.warehouseId,
            catalog: databricksSelection.catalog,
            sourceSchema: databricksSelection.sourceSchema,
            sourceTable: databricksSelection.sourceTable,
            destSchema: databricksSelection.destSchema || devSchema,
            prodSchema: databricksSelection.prodSchema || prodSchema,
          }
        : undefined,
    });
  }, [
    step,
    discovery,
    selectedExplores,
    selectedTiles,
    activeJob?.id,
    pendingJobId,
    devSchema,
    prodSchema,
    databricksSelection,
  ]);

  // Restore Databricks selection into parent state after remount
  useEffect(() => {
    if (databricksSelection || !onDatabricksSelectionChange) return;
    const saved = loadWizardState()?.databricks;
    if (!saved?.warehouseId || !saved.sourceTable) return;
    onDatabricksSelectionChange({
      warehouseId: saved.warehouseId,
      catalog: saved.catalog,
      sourceSchema: saved.sourceSchema,
      sourceTable: saved.sourceTable,
      destSchema: saved.destSchema || DEFAULT_DEV_SCHEMA,
      prodSchema: saved.prodSchema || DEFAULT_PROD_SCHEMA,
    });
  }, [databricksSelection, onDatabricksSelectionChange]);

  useEffect(() => {
    if (databricksSelection?.destSchema) {
      setDevSchema(databricksSelection.destSchema);
    }
    if (databricksSelection?.prodSchema) {
      setProdSchema(databricksSelection.prodSchema);
    }
  }, [databricksSelection?.destSchema, databricksSelection?.prodSchema]);

  // Drop discovery if the user switches to a different source table
  useEffect(() => {
    if (!databricksSelection || !discovery) return;
    const key = wizardSourceKey(databricksSelection);
    const discKey = `${discovery.catalog}.${discovery.schema}.${discovery.table}`;
    if (key !== discKey) {
      setDiscovery(null);
      setSelectedExplores(new Set());
      setSelectedTiles(new Set());
      setStep("source");
    }
  }, [databricksSelection, discovery]);

  useEffect(() => {
    if (!activeJob) return;
    const poll = () => {
      fetch(`/api/migrations/${activeJob.id}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.job) {
            setActiveJob(data.job);
            setJobDetail(toJobDetail(data));
          }
        })
        .catch(() => {});
      fetch("/api/worker/status")
        .then((r) => r.json())
        .then((data) => setWorkerStatus(data as WorkerStatusSnapshot))
        .catch(() => setWorkerStatus(null));
    };
    poll();
    const interval = setInterval(poll, 3000);
    return () => clearInterval(interval);
  }, [activeJob?.id]);

  const schemaErrors = useMemo(() => {
    if (!databricksSelection) return [];
    return validateMigrationSchemas({
      sourceSchema: databricksSelection.sourceSchema,
      devSchema,
      prodSchema,
    }).errors;
  }, [databricksSelection, devSchema, prodSchema]);

  function syncSchemasToSelection(nextDev: string, nextProd: string) {
    setDevSchema(nextDev);
    setProdSchema(nextProd);
    if (databricksSelection && onDatabricksSelectionChange) {
      onDatabricksSelectionChange({
        ...databricksSelection,
        destSchema: nextDev,
        prodSchema: nextProd,
      });
    }
  }

  async function triggerWorkerTick() {
    setWorkerMessage(null);
    try {
      const res = await fetch("/api/worker/tick", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error ?? `Worker tick failed (${res.status})`);
      }
      setWorkerMessage("Worker tick started");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Worker tick failed";
      setWorkerMessage(message);
      setError(
        `Job was created but the worker tick failed: ${message}. Run \`npm run worker\` or retry the tick.`
      );
    }
  }

  async function runDiscovery() {
    if (!databricksSelection) {
      setError("Select a Databricks source table first");
      return;
    }
    if (schemaErrors.length > 0) {
      setError(schemaErrors.join("; "));
      return;
    }

    setDiscovering(true);
    setError(null);
    try {
      const res = await fetch("/api/looker/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalog: databricksSelection.catalog,
          schema: databricksSelection.sourceSchema,
          table: databricksSelection.sourceTable,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Discovery failed");

      const result = data.discovery as TableDiscoveryResult;
      setDiscovery(result);

      // Pre-select high-confidence explores and their tiles; user must confirm
      const highExplores = new Set(
        result.explores
          .filter((e) => e.confidence === "high" || e.confidence === "medium")
          .map((e) => `${e.model}.${e.explore}`)
      );
      setSelectedExplores(highExplores);

      const highTiles = new Set(
        result.tiles
          .filter(
            (t) =>
              highExplores.has(`${t.model}.${t.explore}`) &&
              (t.confidence === "high" || t.confidence === "medium")
          )
          .map((t) => t.id)
      );
      setSelectedTiles(highTiles);
      setStep("discover");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Discovery failed");
    } finally {
      setDiscovering(false);
    }
  }

  function buildConfirmedScope(): ConfirmedMigrationScope | null {
    if (!databricksSelection || !discovery) return null;

    const explores = discovery.explores.filter((e) =>
      selectedExplores.has(`${e.model}.${e.explore}`)
    );
    const tiles = discovery.tiles.filter((t) => selectedTiles.has(t.id));
    const viewNames = new Set(explores.flatMap((e) => e.viewNames));
    const autoViews: DiscoveredView[] = discovery.views.filter(
      (v) =>
        viewNames.has(v.name) ||
        explores.some((e) => e.viewNames.includes(v.name)) ||
        (v.confidence === "high" &&
          (v.name === databricksSelection.sourceTable ||
            explores.some((e) => e.explore === v.name)))
    );

    return {
      sourceTable: {
        catalog: databricksSelection.catalog,
        schema: databricksSelection.sourceSchema,
        table: databricksSelection.sourceTable,
      },
      explores: explores.map((e) => ({
        model: e.model,
        explore: e.explore,
      })),
      tiles,
      views: autoViews,
    };
  }

  async function startTableScopeMigration() {
    if (submittingRef.current) return;
    if (!authenticated || !connectedHost || !databricksSelection) {
      setError("Connect to Databricks and select a source table");
      return;
    }
    if (schemaErrors.length > 0) {
      setError(schemaErrors.join("; "));
      return;
    }

    const scope = buildConfirmedScope();
    if (!scope?.explores.length) {
      setError("Confirm at least one Explore to migrate");
      return;
    }
    if (!scope.tiles.length) {
      setError(
        "Confirm at least one dashboard/Look tile benchmark. Synthetic smoke tests cannot prove parity."
      );
      return;
    }

    submittingRef.current = true;
    setCreating(true);
    setError(null);
    setWorkerMessage(null);
    try {
      const idempotencyKey = newIdempotencyKey("table-scope");
      const res = await fetch("/api/migrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lookerSourceType: "table_scope",
          lookerModel: scope.explores[0].model,
          lookerExplore: scope.explores[0].explore,
          databricksHost: connectedHost,
          warehouseId: databricksSelection.warehouseId,
          catalog: databricksSelection.catalog,
          sourceSchema: databricksSelection.sourceSchema,
          sourceTable: databricksSelection.sourceTable,
          devSchema,
          prodSchema: prodSchema || undefined,
          migrationScope: scope,
          idempotencyKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create migration");

      setActiveJob(data.job);
      refreshJobs();
      await triggerWorkerTick();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start migration");
    } finally {
      submittingRef.current = false;
      setCreating(false);
    }
  }

  async function startLegacyMigration() {
    if (submittingRef.current) return;
    if (!authenticated || !connectedHost || !lookerSelection || !databricksSelection) {
      setError(
        "Connect to Databricks and select both a Looker source and Databricks target"
      );
      return;
    }
    if (schemaErrors.length > 0) {
      setError(schemaErrors.join("; "));
      return;
    }

    submittingRef.current = true;
    setCreating(true);
    setError(null);
    setWorkerMessage(null);
    try {
      const idempotencyKey = newIdempotencyKey("start");
      const res = await fetch("/api/migrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lookerSourceType: lookerSelection.type,
          lookerModel: lookerSelection.model,
          lookerExplore: lookerSelection.explore,
          lookerDashboardId: lookerSelection.dashboardId,
          databricksHost: connectedHost,
          warehouseId: databricksSelection.warehouseId,
          catalog: databricksSelection.catalog,
          sourceSchema: databricksSelection.sourceSchema,
          sourceTable: databricksSelection.sourceTable,
          devSchema,
          prodSchema: prodSchema || undefined,
          idempotencyKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create migration");

      setActiveJob(data.job);
      refreshJobs();
      await triggerWorkerTick();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start migration");
    } finally {
      submittingRef.current = false;
      setCreating(false);
    }
  }

  async function rerunJob(sourceJob: MigrationJobRecord) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setCreating(true);
    setError(null);
    setWorkerMessage(null);
    try {
      const res = await fetch(`/api/migrations/${sourceJob.id}/rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idempotencyKey: newIdempotencyKey("rerun-ui") }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to rerun migration");

      if (data.restoredSelections && onRestoreSelections) {
        onRestoreSelections({
          looker: {
            type: data.restoredSelections.looker.type,
            model: data.restoredSelections.looker.model ?? undefined,
            explore: data.restoredSelections.looker.explore ?? undefined,
            dashboardId: data.restoredSelections.looker.dashboardId ?? undefined,
            dashboardTitle:
              data.restoredSelections.looker.dashboardTitle ?? undefined,
            label: data.restoredSelections.looker.label,
          },
          databricks: data.restoredSelections.databricks,
          prodSchema: data.restoredSelections.prodSchema,
        });
      }
      if (data.restoredSelections?.prodSchema) {
        setProdSchema(data.restoredSelections.prodSchema);
      }
      if (data.restoredSelections?.databricks?.destSchema) {
        setDevSchema(data.restoredSelections.databricks.destSchema);
      }

      setActiveJob(data.job);
      refreshJobs();
      await triggerWorkerTick();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rerun migration");
    } finally {
      submittingRef.current = false;
      setCreating(false);
    }
  }

  async function handleApprove(action: "approve" | "publish") {
    if (!activeJob) return;
    const label =
      action === "approve"
        ? "Approve for production?\n\nThis only authorizes publication. Dev-schema views already exist from validation. Nothing new is written to Databricks until you publish."
        : "Publish to production schema?\n\nThis creates/replaces production SQL and metric views from the validated final snapshot.";
    if (!window.confirm(label)) return;

    const res = await fetch(`/api/migrations/${activeJob.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, confirmed: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Action failed");
      return;
    }
    refreshJobs();
    const detail = await fetch(`/api/migrations/${activeJob.id}`).then((r) =>
      r.json()
    );
    setActiveJob(detail.job);
    setJobDetail(toJobDetail(detail));
  }

  const lastJob = jobs[0] ?? null;
  const confirmedScope = buildConfirmedScope();
  const canDiscover =
    authenticated && databricksSelection && schemaErrors.length === 0 && !discovering;
  const canStartScoped =
    authenticated &&
    confirmedScope &&
    confirmedScope.explores.length > 0 &&
    confirmedScope.tiles.length > 0 &&
    schemaErrors.length === 0 &&
    !creating;

  if (!dbConfigured) {
    return (
      <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">Job database not configured</p>
        <p className="mt-1">
          Migrations are long-running jobs. They need PostgreSQL to persist state.
        </p>
        <p className="mt-2">
          With Docker: <code className="text-xs">npm run db:up</code> then set{" "}
          <code className="text-xs">DATABASE_URL</code> and run{" "}
          <code className="text-xs">npm run db:migrate</code>.
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-zinc-900">
          Table-first migration
        </h2>
        <p className="mt-1 text-sm text-zinc-600">
          Select a Databricks source table, discover Looker Explores and
          dashboard/Look tiles that reference it, confirm scope, then migrate
          semantic logic into SQL and metric views.
        </p>

        {restoredNotice && (
          <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
            {restoredNotice}
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => setRestoredNotice(null)}
            >
              dismiss
            </button>
          </div>
        )}

        <ol className="mt-4 flex flex-wrap gap-2 text-xs font-medium">
          {(
            [
              ["source", "1. Source"],
              ["discover", "2. Discover"],
              ["review", "3. Review & migrate"],
            ] as const
          ).map(([id, label]) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => {
                  if (id === "discover" && !discovery) return;
                  if (id === "review" && !discovery) return;
                  setStep(id);
                }}
                className={`rounded-md px-3 py-1.5 ${
                  step === id
                    ? "bg-zinc-900 text-white"
                    : "border border-zinc-300 text-zinc-700 hover:bg-zinc-50"
                }`}
              >
                {label}
              </button>
            </li>
          ))}
        </ol>

        {step === "source" && (
          <div className="mt-4 space-y-4">
            <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3 text-sm">
              <p className="font-medium text-zinc-700">READ FROM source table</p>
              <p className="mt-1 font-mono text-xs text-zinc-600">
                {databricksSelection
                  ? `${databricksSelection.catalog}.${databricksSelection.sourceSchema}.${databricksSelection.sourceTable}`
                  : "Select a table in the Databricks tab"}
              </p>
              <p className="mt-2 text-xs text-zinc-500">
                Warehouse:{" "}
                {databricksSelection?.warehouseId
                  ? databricksSelection.warehouseId.slice(0, 12) + "…"
                  : "—"}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-zinc-700">
                  WRITE TO dev schema
                </span>
                <input
                  type="text"
                  value={devSchema}
                  onChange={(e) =>
                    syncSchemasToSelection(e.target.value, prodSchema)
                  }
                  placeholder={DEFAULT_DEV_SCHEMA}
                  className="rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-zinc-700">
                  PUBLISH TO prod schema
                </span>
                <input
                  type="text"
                  value={prodSchema}
                  onChange={(e) =>
                    syncSchemasToSelection(devSchema, e.target.value)
                  }
                  placeholder={DEFAULT_PROD_SCHEMA}
                  className="rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
                />
              </label>
            </div>

            {schemaErrors.length > 0 && (
              <ul className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                {schemaErrors.map((err) => (
                  <li key={err}>{err}</li>
                ))}
              </ul>
            )}

            {error && <p className="text-sm text-red-700">{error}</p>}

            <button
              type="button"
              disabled={!canDiscover}
              onClick={runDiscovery}
              className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
            >
              {discovering
                ? "Discovering Looker dependencies…"
                : "Discover Looker dependencies"}
            </button>
          </div>
        )}

        {step === "discover" && discovery && (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-zinc-600">
              Found {discovery.views.length} views, {discovery.explores.length}{" "}
              explores, {discovery.tiles.length} tiles. Views are automatic
              dependencies; Explores are migration units; tiles are validation
              benchmarks. Confirm what to migrate — nothing is assumed.
            </p>

            <DiscoveryList
              title="LookML views (automatic dependencies)"
              items={discovery.views.map((v) => ({
                id: v.name,
                label: v.name,
                confidence: v.confidence,
                evidence: v.evidence.map((e) => e.detail),
                checked: true,
                disabled: true,
              }))}
            />

            <DiscoveryList
              title="Explores (migration units)"
              items={discovery.explores.map((e: DiscoveredExplore) => {
                const id = `${e.model}.${e.explore}`;
                return {
                  id,
                  label: id,
                  confidence: e.confidence,
                  evidence: e.evidence.map((ev) => ev.detail),
                  checked: selectedExplores.has(id),
                  disabled: false,
                  onToggle: () => {
                    setSelectedExplores((prev) => {
                      const next = new Set(prev);
                      if (next.has(id)) next.delete(id);
                      else next.add(id);
                      return next;
                    });
                  },
                };
              })}
            />

            <DiscoveryList
              title="Dashboard / Look tiles (validation benchmarks)"
              items={discovery.tiles.map((t: DiscoveredTile) => ({
                id: t.id,
                label: `${t.title} (${t.model}.${t.explore})`,
                confidence: t.confidence,
                evidence: t.evidence.map((e) => e.detail),
                checked: selectedTiles.has(t.id),
                disabled: false,
                onToggle: () => {
                  setSelectedTiles((prev) => {
                    const next = new Set(prev);
                    if (next.has(t.id)) next.delete(t.id);
                    else next.add(t.id);
                    return next;
                  });
                },
              }))}
            />

            {error && <p className="text-sm text-red-700">{error}</p>}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setStep("source")}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm"
              >
                Back
              </button>
              <button
                type="button"
                disabled={
                  selectedExplores.size === 0 || selectedTiles.size === 0
                }
                onClick={() => setStep("review")}
                className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
              >
                Continue to review
              </button>
            </div>
          </div>
        )}

        {step === "review" && confirmedScope && (
          <div className="mt-4 space-y-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3">
                <dt className="font-medium text-zinc-700">READ FROM</dt>
                <dd className="mt-1 font-mono text-xs">
                  {confirmedScope.sourceTable.catalog}.
                  {confirmedScope.sourceTable.schema}.
                  {confirmedScope.sourceTable.table}
                </dd>
              </div>
              <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3">
                <dt className="font-medium text-zinc-700">WRITE TO (dev)</dt>
                <dd className="mt-1 font-mono text-xs">
                  {databricksSelection?.catalog}.{devSchema}
                </dd>
              </div>
              <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3">
                <dt className="font-medium text-zinc-700">PUBLISH TO (prod)</dt>
                <dd className="mt-1 font-mono text-xs">
                  {databricksSelection?.catalog}.{prodSchema}
                </dd>
              </div>
              <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3">
                <dt className="font-medium text-zinc-700">Selected Explores</dt>
                <dd className="mt-1 text-xs text-zinc-600">
                  {confirmedScope.explores
                    .map((e) => `${e.model}.${e.explore}`)
                    .join(", ")}
                </dd>
              </div>
              <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3 sm:col-span-2">
                <dt className="font-medium text-zinc-700">Benchmark tiles</dt>
                <dd className="mt-1 text-xs text-zinc-600">
                  {confirmedScope.tiles.map((t) => t.title).join(", ")}
                </dd>
              </div>
              <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3 sm:col-span-2">
                <dt className="font-medium text-zinc-700">
                  Proposed objects
                </dt>
                <dd className="mt-1 text-xs text-zinc-600">
                  Base SQL view(s) over the source table, then metric view(s)
                  per Explore. Immutable Looker benchmarks are captured before
                  generation; approval requires every mandatory tile to pass.
                </dd>
              </div>
            </dl>

            {error && <p className="text-sm text-red-700">{error}</p>}
            {workerMessage && !error && (
              <p className="text-sm text-zinc-600">{workerMessage}</p>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setStep("discover")}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm"
              >
                Back
              </button>
              <button
                type="button"
                disabled={!canStartScoped}
                onClick={startTableScopeMigration}
                className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {creating ? "Starting…" : "Start migration"}
              </button>
            </div>
          </div>
        )}

        <div className="mt-6 border-t border-zinc-100 pt-4">
          <button
            type="button"
            className="text-xs text-zinc-500 underline"
            onClick={() => setLegacyMode((v) => !v)}
          >
            {legacyMode
              ? "Hide legacy Looker-first start"
              : "Show legacy Looker-first start"}
          </button>
          {legacyMode && (
            <div className="mt-3 space-y-3">
              <p className="text-xs text-zinc-500">
                Legacy path: pick an explore/dashboard in the Looker tab, then
                start here. Dashboard jobs still capture tile benchmarks before
                generation.
              </p>
              <div className="rounded-md border border-zinc-100 bg-zinc-50 p-3 text-sm">
                Looker: {lookerSelection?.label ?? "none selected"}
              </div>
              <button
                type="button"
                disabled={
                  !authenticated ||
                  !lookerSelection ||
                  !databricksSelection ||
                  schemaErrors.length > 0 ||
                  creating
                }
                onClick={startLegacyMigration}
                className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium"
              >
                Start legacy migration
              </button>
            </div>
          )}
        </div>

        <div className="mt-4">
          <button
            type="button"
            disabled={!authenticated || !lastJob || creating}
            onClick={() => lastJob && rerunJob(lastJob)}
            className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
          >
            Rerun last migration
          </button>
        </div>
      </section>

      {activeJob && (
        <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold text-zinc-900">Active job</h3>
            <StatusBadge status={activeJob.status} />
          </div>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-zinc-500">Phase</dt>
              <dd>{activeJob.currentPhase}</dd>
            </div>
            <div>
              <dt className="text-zinc-500">Iteration</dt>
              <dd>
                {activeJob.iterationCount} / {activeJob.maxIterations}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">READ FROM</dt>
              <dd className="font-mono text-xs">
                {activeJob.catalog}.{activeJob.sourceSchema}.
                {activeJob.sourceTable}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">WRITE TO (dev)</dt>
              <dd className="font-mono text-xs">
                {activeJob.catalog}.{activeJob.devSchema}
              </dd>
            </div>
            <div>
              <dt className="text-zinc-500">PUBLISH TO (prod)</dt>
              <dd className="font-mono text-xs">
                {activeJob.catalog}.
                {activeJob.prodSchema ??
                  activeJob.devSchema.replace(/_dev$/, "_prod")}
              </dd>
            </div>
            {activeJob.status !== "needs_input" && activeJob.errorMessage && (
              <div className="sm:col-span-2">
                <dt className="text-zinc-500">Error</dt>
                <dd className="whitespace-pre-wrap text-red-700">
                  {activeJob.errorMessage}
                </dd>
              </div>
            )}
            {activeJob.parityReport?.approvalBlockedReason && (
              <div className="sm:col-span-2">
                <dt className="text-zinc-500">Approval gate</dt>
                <dd className="text-amber-800">
                  {activeJob.parityReport.approvalBlockedReason}
                </dd>
              </div>
            )}
          </dl>

          <JobActivityPanel
            job={activeJob}
            tests={jobDetail?.tests ?? []}
            iterations={jobDetail?.iterations ?? []}
            events={jobDetail?.events ?? []}
            migrationReport={jobDetail?.migrationReport ?? null}
            workerStatus={workerStatus}
          />

          {(activeJob.status === "needs_input" ||
            activeJob.status === "failed") && (
            <NeedsInputPanel
              job={activeJob}
              report={jobDetail?.migrationReport ?? null}
              creating={creating}
              onRerun={() => rerunJob(activeJob)}
            />
          )}

          {activeJob.status === "awaiting_approval" && (
            <div className="mt-4 space-y-2">
              <button
                type="button"
                onClick={() => handleApprove("approve")}
                className="rounded-md bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
              >
                Approve for production
              </button>
            </div>
          )}
          {activeJob.status === "approved" && (
            <div className="mt-4 space-y-2">
              <button
                type="button"
                onClick={() => handleApprove("publish")}
                className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700"
              >
                Publish to production
              </button>
            </div>
          )}

          {jobDetail && jobDetail.events.length > 0 && (
            <div className="mt-5">
              <h4 className="text-sm font-semibold text-zinc-800">Timeline</h4>
              <ol className="mt-2 space-y-2 border-l border-zinc-200 pl-4">
                {jobDetail.events.map((ev) => (
                  <li key={ev.id} className="relative text-sm">
                    <span className="absolute -left-[1.15rem] top-1.5 h-2 w-2 rounded-full bg-zinc-400" />
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium text-zinc-900">
                        {ev.title}
                      </span>
                      <span className="text-xs text-zinc-400">
                        {new Date(ev.createdAt).toLocaleTimeString()}
                        {ev.iterationNumber
                          ? ` · iter ${ev.iterationNumber}`
                          : ""}
                      </span>
                    </div>
                    {ev.detail && (
                      <p className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-600">
                        {ev.detail.length > 280
                          ? `${ev.detail.slice(0, 280)}…`
                          : ev.detail}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {jobDetail && (jobDetail.migrationReport || jobDetail.tests.length > 0) && (
            <ParityScorecard
              report={jobDetail.migrationReport}
              tests={jobDetail.tests}
              databricksHost={activeJob.databricksHost}
              catalog={activeJob.catalog}
              devSchema={activeJob.devSchema}
            />
          )}

          {jobDetail?.migrationReport && (
            <MigrationReportPanel report={jobDetail.migrationReport} />
          )}

          {jobDetail && latestTests(jobDetail.tests).length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold text-zinc-800">
                Latest test results
              </h4>
              <ul className="mt-2 space-y-1 text-sm">
                {latestTests(jobDetail.tests).map((t, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <TestStatusIcon status={t.status} />
                    <div>
                      <span className="font-medium">{t.test_name}</span>
                      <span className="ml-2 text-xs uppercase text-zinc-500">
                        {t.status}
                      </span>
                      <p className="text-zinc-500">{t.diff_summary}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {activeJob.parityReport && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-semibold text-zinc-800">
                Parity report (raw)
              </summary>
              <pre className="mt-2 overflow-auto rounded-md bg-zinc-50 p-3 font-mono text-xs">
                {JSON.stringify(activeJob.parityReport, null, 2)}
              </pre>
            </details>
          )}

          {activeJob.status !== "needs_input" &&
            activeJob.status !== "failed" && (
              <div className="mt-4">
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => rerunJob(activeJob)}
                  className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                >
                  Rerun this configuration
                </button>
              </div>
            )}
        </section>
      )}

      {jobs.length > 0 && (
        <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-zinc-800">Recent jobs</h3>
          <ul className="mt-2 divide-y divide-zinc-100">
            {jobs.map((job) => (
              <li
                key={job.id}
                className="flex items-center justify-between gap-2 py-2 text-sm hover:bg-zinc-50"
              >
                <button
                  type="button"
                  className="flex-1 text-left"
                  onClick={() => setActiveJob(job)}
                >
                  {job.lookerSourceType === "table_scope"
                    ? `${job.catalog}.${job.sourceSchema}.${job.sourceTable}`
                    : job.lookerSourceType === "dashboard"
                      ? job.lookerDashboardTitle ?? job.lookerDashboardId
                      : `${job.lookerModel}.${job.lookerExplore}`}
                </button>
                <StatusBadge status={job.status} />
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => rerunJob(job)}
                  className="rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:bg-white disabled:opacity-50"
                >
                  Rerun
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function DiscoveryList({
  title,
  items,
}: {
  title: string;
  items: Array<{
    id: string;
    label: string;
    confidence: string;
    evidence: string[];
    checked: boolean;
    disabled: boolean;
    onToggle?: () => void;
  }>;
}) {
  if (items.length === 0) {
    return (
      <div>
        <h4 className="text-sm font-semibold text-zinc-800">{title}</h4>
        <p className="mt-1 text-xs text-zinc-500">None found</p>
      </div>
    );
  }

  return (
    <div>
      <h4 className="text-sm font-semibold text-zinc-800">{title}</h4>
      <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto">
        {items.map((item) => (
          <li
            key={item.id}
            className="rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2 text-sm"
          >
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={item.checked}
                disabled={item.disabled}
                onChange={item.onToggle}
              />
              <span className="flex-1">
                <span className="font-medium text-zinc-800">{item.label}</span>
                <ConfidenceBadge confidence={item.confidence} />
                <ul className="mt-1 text-xs text-zinc-500">
                  {item.evidence.slice(0, 3).map((e) => (
                    <li key={e}>• {e}</li>
                  ))}
                </ul>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const colors: Record<string, string> = {
    high: "bg-green-100 text-green-800",
    medium: "bg-amber-100 text-amber-800",
    low: "bg-zinc-100 text-zinc-600",
  };
  return (
    <span
      className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${colors[confidence] ?? colors.low}`}
    >
      {confidence}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-zinc-100 text-zinc-700",
    running: "bg-blue-100 text-blue-700",
    awaiting_approval: "bg-amber-100 text-amber-800",
    approved: "bg-green-100 text-green-700",
    published: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-700",
    needs_input: "bg-purple-100 text-purple-700",
    cancelled: "bg-zinc-100 text-zinc-500",
  };
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-zinc-100"}`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function TestStatusIcon({ status }: { status: string }) {
  if (status === "pass" || status === "recreated")
    return <span className="text-green-600">✓</span>;
  if (status === "pass_with_boundary_drift" || status === "close_match")
    return <span className="text-emerald-600">≈</span>;
  if (status === "fail" || status === "error" || status === "mismatch")
    return <span className="text-red-600">✗</span>;
  if (
    status === "inconclusive" ||
    status === "unsupported" ||
    status === "compile_error" ||
    status === "query_compilation_error"
  )
    return <span className="text-amber-600">!</span>;
  return <span className="text-zinc-400">○</span>;
}

/** Keep only the most recent iteration's tests (tests accumulate across iterations). */
function latestTests(tests: TestRow[]): TestRow[] {
  let latestId: string | null = null;
  for (const t of tests) {
    if (t.iteration_id) latestId = t.iteration_id;
  }
  if (!latestId) return tests;
  return tests.filter((t) => t.iteration_id === latestId);
}

function NeedsInputPanel({
  job,
  report,
  creating,
  onRerun,
}: {
  job: MigrationJobRecord;
  report: MigrationReport | null;
  creating: boolean;
  onRerun: () => void;
}) {
  const writeTarget = `${job.catalog}.${job.devSchema}`;
  const written =
    report?.writtenToDatabricks ??
    job.parityReport?.objectsCreated?.map((o) => ({
      type: o.type,
      name: o.name,
      fqn: `${job.catalog}.${o.schema}.${o.name}`,
    })) ??
    [];
  const whatWasDone =
    report?.whatWasDone ??
    (written.length
      ? [`Wrote ${written.length} object(s) to ${writeTarget}.`]
      : ["Job paused before a durable Databricks write was confirmed."]);
  const nextSteps =
    report?.nextSteps ??
    [
      `Inspect Databricks schema ${writeTarget}.`,
      "Rerun this configuration after reviewing the pause reason.",
    ];
  const reason =
    report?.pauseReason ??
    job.errorMessage ??
    "The agent paused and needs guidance.";

  return (
    <div className="mt-4 space-y-3 rounded-md border border-purple-200 bg-purple-50/60 p-4">
      <div>
        <h4 className="text-sm font-semibold text-purple-900">
          {job.status === "needs_input"
            ? "Needs input — here's what happened"
            : "Migration stopped — here's what happened"}
        </h4>
        <p className="mt-1 whitespace-pre-wrap text-sm text-purple-950/90">
          {reason.split("\n")[0]}
        </p>
      </div>

      <div>
        <h5 className="text-xs font-semibold uppercase tracking-wide text-purple-800">
          Written to Databricks
        </h5>
        {written.length > 0 ? (
          <ul className="mt-1 space-y-0.5 font-mono text-xs text-zinc-800">
            {written.map((o) => (
              <li key={o.fqn}>
                {o.type}: {o.fqn}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-zinc-600">
            No objects confirmed in {writeTarget} yet.
          </p>
        )}
      </div>

      <div>
        <h5 className="text-xs font-semibold uppercase tracking-wide text-purple-800">
          What was done
        </h5>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-zinc-800">
          {whatWasDone.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>

      <div>
        <h5 className="text-xs font-semibold uppercase tracking-wide text-purple-800">
          What to do next
        </h5>
        <ol className="mt-1 list-decimal space-y-1 pl-4 text-sm text-zinc-800">
          {nextSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          disabled={creating}
          onClick={onRerun}
          className="rounded-md bg-purple-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-800 disabled:opacity-50"
        >
          Rerun migration
        </button>
        <a
          href={`https://${job.databricksHost.replace(/^https?:\/\//, "")}/explore/data/${job.catalog}/${job.devSchema}`}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-purple-300 bg-white px-3 py-1.5 text-sm font-medium text-purple-900 hover:bg-purple-50"
        >
          Open Databricks schema
        </a>
      </div>
    </div>
  );
}

function MigrationReportPanel({ report }: { report: MigrationReport }) {
  const groups: Array<{
    key: MigrationReport["tiles"][number]["status"];
    label: string;
  }> = [
    { key: "recreated", label: "Exact match" },
    { key: "close_match", label: "Close match (top-N drift)" },
    { key: "mismatch", label: "Mismatch" },
    { key: "unsupported", label: "Unsupported" },
    { key: "compile_error", label: "Compile error" },
    { key: "inconclusive", label: "Inconclusive" },
    { key: "error", label: "Error" },
  ];

  const usable = report.summary.recreated + (report.summary.closeMatch ?? 0);

  return (
    <div className="mt-5">
      <h4 className="text-sm font-semibold text-zinc-800">Migration report</h4>
      <p className="mt-1 text-xs text-zinc-500">
        {usable}/{report.summary.total} tiles usable
        {report.summary.closeMatch
          ? ` (${report.summary.recreated} exact · ${report.summary.closeMatch} close)`
          : ""}{" "}
        · target <span className="font-mono">{report.writeTarget}</span>
      </p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {groups.map(({ key, label }) => {
          const tiles = report.tiles.filter((t) => t.status === key);
          if (tiles.length === 0) return null;
          return (
            <div
              key={key}
              className="rounded-md border border-zinc-100 bg-zinc-50 px-3 py-2"
            >
              <h5 className="text-xs font-semibold uppercase text-zinc-600">
                {label} ({tiles.length})
              </h5>
              <ul className="mt-1 max-h-36 space-y-1 overflow-y-auto text-xs">
                {tiles.map((t) => (
                  <li key={t.name} className="flex items-start gap-1.5">
                    <TestStatusIcon status={t.status} />
                    <span>
                      <span className="font-medium text-zinc-800">{t.name}</span>
                      {t.summary && (
                        <span className="block text-zinc-500">
                          {t.summary.length > 140
                            ? `${t.summary.slice(0, 140)}…`
                            : t.summary}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

