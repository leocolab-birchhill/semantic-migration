"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ConnectForm } from "@/components/ConnectForm";
import { FileTree } from "@/components/FileTree";
import { LookerReferencedTables } from "@/components/LookerReferencedTables";
import { PermissionReport } from "@/components/PermissionReport";
import type { ExplorerNode } from "@/lib/explorer-types";
import type { DatabricksSelection } from "@/components/MigrationPanel";
import type { PermissionAssessment, ResourceSelection } from "@/lib/types";
import {
  DEFAULT_DEV_SCHEMA,
  DEFAULT_PROD_SCHEMA,
  validateMigrationSchemas,
} from "@/lib/migration/schema-guard";

interface DatabricksPanelProps {
  authenticated: boolean;
  connectedHost: string | null;
  configuredHost: string | null;
  oauthConfigured?: boolean;
  envAuthConfigured?: boolean;
  envAuthError?: string | null;
  cliProfiles?: Array<{ purpose: string; profile: string; loginCommand: string }>;
  reauthCommand?: string;
  authMode?: "oauth" | "env" | null;
  onDisconnect: () => void;
  onRecheckAuth?: () => void;
  onSelectionChange?: (selection: DatabricksSelection) => void;
  destSchemaOverride?: string;
  prodSchemaOverride?: string;
}

export function DatabricksPanel({
  authenticated,
  connectedHost,
  configuredHost,
  oauthConfigured = true,
  envAuthConfigured = false,
  envAuthError = null,
  cliProfiles = [],
  reauthCommand = "npm run auth:databricks",
  authMode,
  onDisconnect,
  onRecheckAuth,
  onSelectionChange,
  destSchemaOverride,
  prodSchemaOverride,
}: DatabricksPanelProps) {
  const [warehouses, setWarehouses] = useState<
    Array<{ id: string; name: string; state: string }>
  >([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [warehouseLoading, setWarehouseLoading] = useState(false);
  const [warehouseError, setWarehouseError] = useState<string | null>(null);
  const [warehouseReloadKey, setWarehouseReloadKey] = useState(0);
  const [selectedNode, setSelectedNode] = useState<ExplorerNode | null>(null);
  const [assessment, setAssessment] = useState<PermissionAssessment | null>(
    null
  );
  const [permLoading, setPermLoading] = useState(false);
  const [probeLoading, setProbeLoading] = useState(false);
  const [destSchema, setDestSchema] = useState(DEFAULT_DEV_SCHEMA);
  const [prodSchema, setProdSchema] = useState(DEFAULT_PROD_SCHEMA);

  useEffect(() => {
    if (destSchemaOverride !== undefined) setDestSchema(destSchemaOverride);
  }, [destSchemaOverride]);

  useEffect(() => {
    if (prodSchemaOverride !== undefined) setProdSchema(prodSchemaOverride);
  }, [prodSchemaOverride]);

  useEffect(() => {
    if (!authenticated) {
      setWarehouses([]);
      setWarehouseId("");
      setWarehouseError(null);
      return;
    }
    let cancelled = false;
    setWarehouseLoading(true);
    setWarehouseError(null);
    fetch("/api/databricks/warehouses")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to list warehouses");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setWarehouses(data.warehouses ?? []);
        if (data.warehouses?.[0]) setWarehouseId(data.warehouses[0].id);
        else setWarehouseId("");
      })
      .catch((err) => {
        if (cancelled) return;
        setWarehouses([]);
        setWarehouseId("");
        setWarehouseError(
          err instanceof Error ? err.message : "Failed to list warehouses"
        );
      })
      .finally(() => {
        if (!cancelled) setWarehouseLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authenticated, warehouseReloadKey]);

  const loadTree = useCallback(
    async (path: string): Promise<ExplorerNode[]> => {
      if (!warehouseId) return [];
      const res = await fetch(
        `/api/databricks/tree?warehouseId=${encodeURIComponent(warehouseId)}&path=${encodeURIComponent(path)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load catalog tree");
      return data.nodes ?? [];
    },
    [warehouseId]
  );

  function buildSelection(): ResourceSelection | null {
    if (!warehouseId || !selectedNode?.meta) return null;
    const { catalog, schema, table } = selectedNode.meta;
    if (!catalog || !schema) return null;
    const dest = destSchema || DEFAULT_DEV_SCHEMA;
    if (selectedNode.type === "table" && table) {
      return {
        warehouseId,
        catalog,
        sourceSchema: schema,
        sourceTable: table,
        destSchema: dest,
        createNewSchema: dest !== schema,
      };
    }
    if (selectedNode.type === "schema") {
      return {
        warehouseId,
        catalog,
        sourceSchema: schema,
        sourceTable: "",
        destSchema: dest,
        createNewSchema: false,
      };
    }
    return null;
  }

  const selection = buildSelection();
  const sourceCatalog = selectedNode?.meta?.catalog ?? "";
  const sourceSchemaName = selectedNode?.meta?.schema ?? "";
  const sourceTable = selectedNode?.meta?.table ?? "";

  const schemaErrors = useMemo(() => {
    if (!sourceSchemaName) return [];
    return validateMigrationSchemas({
      sourceSchema: sourceSchemaName,
      devSchema: destSchema,
      prodSchema,
    }).errors;
  }, [sourceSchemaName, destSchema, prodSchema]);

  useEffect(() => {
    if (!onSelectionChange) return;
    if (
      !warehouseId ||
      !sourceCatalog ||
      !sourceSchemaName ||
      !sourceTable ||
      !destSchema
    ) {
      return;
    }
    onSelectionChange({
      warehouseId,
      catalog: sourceCatalog,
      sourceSchema: sourceSchemaName,
      sourceTable,
      destSchema,
      prodSchema,
    });
  }, [
    warehouseId,
    sourceCatalog,
    sourceSchemaName,
    sourceTable,
    destSchema,
    prodSchema,
    onSelectionChange,
  ]);

  async function runPermissionChecks() {
    if (!selection?.sourceTable) {
      alert("Select a source table to run full permission checks");
      return;
    }
    if (schemaErrors.length > 0) {
      alert(schemaErrors.join("\n"));
      return;
    }
    setPermLoading(true);
    setAssessment(null);
    try {
      const res = await fetch("/api/databricks/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Permission check failed");
      setAssessment(data);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Permission check failed");
    } finally {
      setPermLoading(false);
    }
  }

  async function runWriteProbe() {
    if (!selection?.destSchema) return;
    if (schemaErrors.length > 0) {
      alert(schemaErrors.join("\n"));
      return;
    }
    const ok = window.confirm(
      "This will CREATE and DROP a temporary probe view in the destination schema. Continue?"
    );
    if (!ok) return;
    setProbeLoading(true);
    try {
      const res = await fetch("/api/databricks/permissions/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouseId: selection.warehouseId,
          catalog: selection.catalog,
          destSchema: selection.destSchema,
          confirmed: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Write probe failed");
      setAssessment((prev) =>
        prev
          ? {
              checks: [...prev.checks, ...data.checks],
              allPassed: prev.allPassed && data.allPassed,
            }
          : data
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Write probe failed");
    } finally {
      setProbeLoading(false);
    }
  }

  function handleSelect(node: ExplorerNode) {
    setSelectedNode(node);
    if (!destSchema) setDestSchema(DEFAULT_DEV_SCHEMA);
    if (!prodSchema) setProdSchema(DEFAULT_PROD_SCHEMA);
    setAssessment(null);
  }

  return (
    <div className="space-y-4">
      <ConnectForm
        configuredHost={configuredHost}
        oauthConfigured={oauthConfigured}
        envAuthConfigured={envAuthConfigured}
        envAuthError={envAuthError}
        cliProfiles={cliProfiles}
        reauthCommand={reauthCommand}
        authMode={authMode}
        authenticated={authenticated}
        connectedHost={connectedHost}
        onDisconnect={onDisconnect}
        onRecheck={onRecheckAuth}
      />

      {authenticated && (
        <>
          <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
            <label className="flex flex-col gap-1 text-sm sm:max-w-md">
              <span className="font-medium text-zinc-700">SQL warehouse</span>
              <select
                value={warehouseId}
                onChange={(e) => {
                  setWarehouseId(e.target.value);
                  setSelectedNode(null);
                  setAssessment(null);
                }}
                disabled={warehouseLoading || Boolean(warehouseError)}
                className="rounded-md border border-zinc-300 px-3 py-2 disabled:bg-zinc-50"
              >
                <option value="">
                  {warehouseLoading
                    ? "Loading warehouses…"
                    : warehouseError
                      ? "Warehouses unavailable"
                      : "Select warehouse…"}
                </option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.state})
                  </option>
                ))}
              </select>
            </label>
            {warehouseError && (
              <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                <p>{warehouseError}</p>
                <p className="mt-1 text-xs text-red-800/80">
                  Auth can look connected while the warehouse API is unreachable
                  (often corporate SSL: restart via{" "}
                  <code className="rounded bg-red-100 px-1">
                    npm run start:local
                  </code>{" "}
                  or{" "}
                  <code className="rounded bg-red-100 px-1">npm run dev</code>
                  ). No separate reboot beyond restarting those processes.
                </p>
                <button
                  type="button"
                  onClick={() => setWarehouseReloadKey((k) => k + 1)}
                  className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm text-red-950 hover:bg-red-100"
                >
                  Retry loading warehouses
                </button>
              </div>
            )}
            {!warehouseLoading && !warehouseError && warehouses.length === 0 && (
              <p className="mt-2 text-xs text-zinc-500">
                No SQL warehouses returned for this workspace.
              </p>
            )}
          </div>

          <LookerReferencedTables
            warehouseId={warehouseId}
            onSelectTable={handleSelect}
            selectedPath={selectedNode?.path ?? null}
          />

          <div
            className="grid gap-4 lg:grid-cols-2"
            style={{ minHeight: "420px" }}
          >
            <FileTree
              key={warehouseId}
              title="Unity Catalog"
              loadChildren={loadTree}
              onSelect={handleSelect}
              rootLabel="Catalogs"
            />

            <div className="space-y-4">
              <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
                <h3 className="text-sm font-semibold text-zinc-900">
                  Selection
                </h3>
                {selectedNode ? (
                  <dl className="mt-2 space-y-1 text-sm text-zinc-600">
                    <div>
                      <dt className="text-zinc-500">Type</dt>
                      <dd>{selectedNode.type}</dd>
                    </div>
                    <div>
                      <dt className="text-zinc-500">Path</dt>
                      <dd className="font-mono text-xs">{selectedNode.path}</dd>
                    </div>
                    {selectedNode.meta?.table && (
                      <div>
                        <dt className="text-zinc-500">Qualified table</dt>
                        <dd className="font-mono text-xs">
                          {selectedNode.meta.catalog}.
                          {selectedNode.meta.schema}.{selectedNode.meta.table}
                        </dd>
                      </div>
                    )}
                  </dl>
                ) : (
                  <p className="mt-2 text-sm text-zinc-500">
                    Pick a Looker-referenced table above, or expand catalogs and
                    select a source table (read-only)
                  </p>
                )}

                <label className="mt-4 flex flex-col gap-1 text-sm">
                  <span className="font-medium text-zinc-700">
                    Dev schema (WRITE TO)
                  </span>
                  <input
                    type="text"
                    value={destSchema}
                    onChange={(e) => setDestSchema(e.target.value)}
                    placeholder={DEFAULT_DEV_SCHEMA}
                    className="rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
                  />
                </label>

                <label className="mt-3 flex flex-col gap-1 text-sm">
                  <span className="font-medium text-zinc-700">
                    Prod schema (PUBLISH TO)
                  </span>
                  <input
                    type="text"
                    value={prodSchema}
                    onChange={(e) => setProdSchema(e.target.value)}
                    placeholder={DEFAULT_PROD_SCHEMA}
                    className="rounded-md border border-zinc-300 px-3 py-2 font-mono text-xs"
                  />
                </label>

                {schemaErrors.length > 0 && (
                  <ul className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-800">
                    {schemaErrors.map((err) => (
                      <li key={err}>{err}</li>
                    ))}
                  </ul>
                )}
              </div>

              <PermissionReport
                assessment={assessment}
                loading={permLoading}
                probeLoading={probeLoading}
                canRun={Boolean(
                  selection?.sourceTable &&
                    destSchema &&
                    schemaErrors.length === 0
                )}
                onRunChecks={runPermissionChecks}
                onRunProbe={runWriteProbe}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
