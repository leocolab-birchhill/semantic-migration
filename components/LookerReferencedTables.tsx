"use client";

import { useCallback, useMemo, useState } from "react";
import type { ExplorerNode } from "@/lib/explorer-types";
import type { LookerReferencedTable } from "@/lib/migration/types";

interface LookerReferencedTablesProps {
  warehouseId: string;
  onSelectTable: (node: ExplorerNode) => void;
  selectedPath?: string | null;
}

type TreeGroup = {
  catalogKey: string;
  catalogLabel: string;
  schemas: Array<{
    schemaKey: string;
    schemaLabel: string;
    tables: LookerReferencedTable[];
  }>;
};

function buildTree(tables: LookerReferencedTable[]): TreeGroup[] {
  const byCatalog = new Map<string, Map<string, LookerReferencedTable[]>>();

  for (const table of tables) {
    const catalogKey = (table.catalog ?? "(unspecified catalog)").toLowerCase();
    const schemaKey = (table.schema ?? "(unspecified schema)").toLowerCase();
    if (!byCatalog.has(catalogKey)) byCatalog.set(catalogKey, new Map());
    const schemas = byCatalog.get(catalogKey)!;
    if (!schemas.has(schemaKey)) schemas.set(schemaKey, []);
    schemas.get(schemaKey)!.push(table);
  }

  return Array.from(byCatalog.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([catalogKey, schemas]) => {
      const first = schemas.values().next().value?.[0];
      return {
        catalogKey,
        catalogLabel: first?.catalog ?? "(unspecified catalog)",
        schemas: Array.from(schemas.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([schemaKey, schemaTables]) => ({
            schemaKey,
            schemaLabel: schemaTables[0]?.schema ?? "(unspecified schema)",
            tables: schemaTables,
          })),
      };
    });
}

function sourceSummary(table: LookerReferencedTable): string {
  const views = new Set(
    table.sources.map((s) => s.viewName).filter(Boolean) as string[]
  );
  const explores = new Set(
    table.sources
      .filter((s) => s.model && s.explore)
      .map((s) => `${s.model}.${s.explore}`)
  );
  const parts: string[] = [];
  if (views.size) parts.push(`${views.size} view${views.size === 1 ? "" : "s"}`);
  if (explores.size)
    parts.push(`${explores.size} explore${explores.size === 1 ? "" : "s"}`);
  if (!parts.length) parts.push(`${table.sources.length} reference(s)`);
  return parts.join(", ");
}

function displayName(table: LookerReferencedTable): string {
  if (table.catalog && table.schema) {
    return `${table.schema}.${table.table}`;
  }
  if (table.schema) return `${table.schema}.${table.table}`;
  return table.table;
}

function toExplorerNode(
  catalog: string,
  schema: string,
  table: string
): ExplorerNode {
  const path = `${catalog}/${schema}/${table}`;
  return {
    id: `looker-ref:${path}`,
    name: table,
    type: "table",
    path,
    hasChildren: false,
    meta: { catalog, schema, table },
  };
}

export function LookerReferencedTables({
  warehouseId,
  onSelectTable,
  selectedPath,
}: LookerReferencedTablesProps) {
  const [tables, setTables] = useState<LookerReferencedTable[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [resolvingKey, setResolvingKey] = useState<string | null>(null);
  /** Cache Looker schema.table → resolved Unity Catalog location */
  const [resolved, setResolved] = useState<
    Record<string, { catalog: string; schema: string; table: string }>
  >({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/looker/referenced-tables");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to scan Looker");
      const next = (data.tables ?? []) as LookerReferencedTable[];
      setTables(next);
      setResolved({});
      setTruncated(Boolean(data.truncated));
      setFileCount(Number(data.fileCount ?? 0));
      if (next.length > 0) {
        const first = next[0];
        const catalogKey = (
          first.catalog ?? "(unspecified catalog)"
        ).toLowerCase();
        const schemaKey = (
          first.schema ?? "(unspecified schema)"
        ).toLowerCase();
        setExpanded(
          new Set([`c:${catalogKey}`, `s:${catalogKey}/${schemaKey}`])
        );
      }
    } catch (err) {
      setTables(null);
      setError(err instanceof Error ? err.message : "Failed to scan Looker");
    } finally {
      setLoading(false);
    }
  }, []);

  const filtered = useMemo(() => {
    if (!tables) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => {
      const hay = [
        t.canonical,
        ...t.sources.map((s) => s.viewName ?? ""),
        ...t.sources.map((s) =>
          s.model && s.explore ? `${s.model}.${s.explore}` : ""
        ),
        ...t.sources.map((s) => s.path ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [tables, filter]);

  const tree = useMemo(() => buildTree(filtered), [filtered]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function cacheKey(table: LookerReferencedTable): string {
    return table.canonical;
  }

  function resolvedPath(table: LookerReferencedTable): string | null {
    const hit = resolved[cacheKey(table)];
    if (hit) return `${hit.catalog}/${hit.schema}/${hit.table}`;
    if (table.catalog && table.schema && table.table) {
      return `${table.catalog}/${table.schema}/${table.table}`;
    }
    return null;
  }

  async function handlePick(table: LookerReferencedTable) {
    setError(null);

    if (!table.schema || !table.table) {
      setError(
        `Cannot select ${table.canonical}: Looker reference is missing schema/table.`
      );
      return;
    }

    if (!warehouseId) {
      setError("Select a SQL warehouse first, then click a table.");
      return;
    }

    const cached = resolved[cacheKey(table)];
    if (cached) {
      onSelectTable(toExplorerNode(cached.catalog, cached.schema, cached.table));
      return;
    }

    // Looker often omits catalog (schema.table only). Resolve against UC.
    if (table.catalog) {
      onSelectTable(toExplorerNode(table.catalog, table.schema, table.table));
      return;
    }

    const key = cacheKey(table);
    setResolvingKey(key);
    try {
      const res = await fetch("/api/databricks/resolve-table", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouseId,
          schema: table.schema,
          table: table.table,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          data.error ??
            `Could not find ${table.schema}.${table.table} in Unity Catalog for this warehouse.`
        );
        return;
      }
      const match = data.match as {
        catalog: string;
        schema: string;
        table: string;
      };
      setResolved((prev) => ({ ...prev, [key]: match }));
      onSelectTable(toExplorerNode(match.catalog, match.schema, match.table));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to resolve table"
      );
    } finally {
      setResolvingKey((current) => (current === key ? null : current));
    }
  }

  return (
    <div className="rounded-lg border border-zinc-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2">
        <div>
          <h3 className="text-sm font-semibold text-zinc-800">
            Referenced by Looker
          </h3>
          <p className="text-xs text-zinc-500">
            Databricks tables found in LookML / explore{" "}
            <code className="rounded bg-zinc-100 px-1">sql_table_name</code> —
            click to select (catalog is resolved from Unity Catalog when Looker
            omits it).
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50"
        >
          {loading
            ? "Scanning Looker…"
            : tables
              ? "Refresh"
              : "Scan Looker references"}
        </button>
      </div>

      <div className="max-h-64 overflow-auto p-2">
        {error && (
          <p className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
            {error}
          </p>
        )}

        {!tables && !loading && !error && (
          <p className="px-2 py-3 text-xs text-zinc-500">
            Scan Looker to list Unity Catalog objects already wired into views
            and explores — useful before browsing the full catalog tree below.
          </p>
        )}

        {loading && (
          <p className="px-2 py-3 text-xs text-zinc-500">
            Walking LookML projects and explore metadata…
          </p>
        )}

        {tables && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter tables, views, explores…"
                className="min-w-[12rem] flex-1 rounded-md border border-zinc-300 px-2 py-1 text-xs"
              />
              <span className="text-xs text-zinc-500">
                {filtered.length} table{filtered.length === 1 ? "" : "s"}
                {truncated ? ` (scanned ${fileCount} LookML files, capped)` : ""}
              </span>
            </div>

            {filtered.length === 0 ? (
              <p className="px-2 py-2 text-xs text-zinc-500">
                No matching Looker-referenced tables.
              </p>
            ) : (
              tree.map((catalog) => {
                const catalogId = `c:${catalog.catalogKey}`;
                const catalogOpen = expanded.has(catalogId);
                return (
                  <div key={catalogId} className="mb-1">
                    <button
                      type="button"
                      onClick={() => toggle(catalogId)}
                      className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm text-zinc-800 hover:bg-zinc-100"
                    >
                      <span className="w-4 text-xs text-zinc-400">
                        {catalogOpen ? "▾" : "▸"}
                      </span>
                      <span className="font-medium">{catalog.catalogLabel}</span>
                    </button>
                    {catalogOpen &&
                      catalog.schemas.map((schema) => {
                        const schemaId = `s:${catalog.catalogKey}/${schema.schemaKey}`;
                        const schemaOpen = expanded.has(schemaId);
                        return (
                          <div key={schemaId}>
                            <button
                              type="button"
                              onClick={() => toggle(schemaId)}
                              className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm text-zinc-700 hover:bg-zinc-100"
                              style={{ paddingLeft: 20 }}
                            >
                              <span className="w-4 text-xs text-zinc-400">
                                {schemaOpen ? "▾" : "▸"}
                              </span>
                              <span>{schema.schemaLabel}</span>
                            </button>
                            {schemaOpen &&
                              schema.tables.map((table) => {
                                const path = resolvedPath(table);
                                const selected =
                                  path != null && selectedPath === path;
                                const isResolving =
                                  resolvingKey === cacheKey(table);
                                const resolvedHit = resolved[cacheKey(table)];
                                return (
                                  <button
                                    key={table.canonical}
                                    type="button"
                                    onClick={() => void handlePick(table)}
                                    disabled={isResolving || !warehouseId}
                                    title={table.sources
                                      .map((s) => s.detail)
                                      .slice(0, 5)
                                      .join("\n")}
                                    className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left text-sm hover:bg-orange-50 disabled:cursor-wait disabled:opacity-60 ${
                                      selected
                                        ? "bg-orange-50 text-orange-900"
                                        : "text-zinc-800"
                                    }`}
                                    style={{ paddingLeft: 36 }}
                                  >
                                    <span className="font-mono text-xs">
                                      {displayName(table)}
                                    </span>
                                    <span className="text-[11px] text-zinc-500">
                                      {isResolving
                                        ? "Resolving catalog…"
                                        : resolvedHit
                                          ? `${resolvedHit.catalog}.${resolvedHit.schema}.${resolvedHit.table}`
                                          : table.catalog
                                            ? sourceSummary(table)
                                            : `${sourceSummary(table)} · click to resolve catalog`}
                                    </span>
                                  </button>
                                );
                              })}
                          </div>
                        );
                      })}
                  </div>
                );
              })
            )}
          </>
        )}
      </div>
    </div>
  );
}
