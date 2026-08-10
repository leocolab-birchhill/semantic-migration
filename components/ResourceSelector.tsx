"use client";

import { useCallback, useEffect, useState } from "react";

export interface SelectionState {
  warehouseId: string;
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
  destSchema: string;
  createNewSchema: boolean;
}

interface ResourceSelectorProps {
  onChange: (selection: SelectionState | null) => void;
}

export function ResourceSelector({ onChange }: ResourceSelectorProps) {
  const [warehouses, setWarehouses] = useState<Array<{ id: string; name: string; state: string }>>([]);
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [sourceSchemas, setSourceSchemas] = useState<string[]>([]);
  const [destSchemas, setDestSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [warehouseId, setWarehouseId] = useState("");
  const [catalog, setCatalog] = useState("");
  const [sourceSchema, setSourceSchema] = useState("");
  const [sourceTable, setSourceTable] = useState("");
  const [destSchema, setDestSchema] = useState("");
  const [createNewSchema, setCreateNewSchema] = useState(false);

  useEffect(() => {
    fetch("/api/databricks/warehouses")
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error);
        return res.json();
      })
      .then((data) => setWarehouses(data.warehouses ?? []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!warehouseId) return;
    setCatalog("");
    setSourceSchema("");
    setSourceTable("");
    setDestSchema("");
    fetch(`/api/databricks/catalogs?warehouseId=${encodeURIComponent(warehouseId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error);
        return res.json();
      })
      .then((data) => setCatalogs(data.catalogs ?? []))
      .catch((err) => setError(err.message));
  }, [warehouseId]);

  const loadSchemas = useCallback(
    (cat: string) => {
      if (!warehouseId || !cat) return;
      fetch(
        `/api/databricks/schemas?warehouseId=${encodeURIComponent(warehouseId)}&catalog=${encodeURIComponent(cat)}`
      )
        .then(async (res) => {
          if (!res.ok) throw new Error((await res.json()).error);
          return res.json();
        })
        .then((data) => {
          setSourceSchemas(data.schemas ?? []);
          setDestSchemas(data.schemas ?? []);
        })
        .catch((err) => setError(err.message));
    },
    [warehouseId]
  );

  useEffect(() => {
    if (catalog) loadSchemas(catalog);
  }, [catalog, loadSchemas]);

  useEffect(() => {
    if (!warehouseId || !catalog || !sourceSchema) return;
    setSourceTable("");
    fetch(
      `/api/databricks/tables?warehouseId=${encodeURIComponent(warehouseId)}&catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(sourceSchema)}`
    )
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error);
        return res.json();
      })
      .then((data) => setTables(data.tables ?? []))
      .catch((err) => setError(err.message));
  }, [warehouseId, catalog, sourceSchema]);

  useEffect(() => {
    if (warehouseId && catalog && sourceSchema && sourceTable && destSchema) {
      onChange({
        warehouseId,
        catalog,
        sourceSchema,
        sourceTable,
        destSchema,
        createNewSchema,
      });
    } else {
      onChange(null);
    }
  }, [
    warehouseId,
    catalog,
    sourceSchema,
    sourceTable,
    destSchema,
    createNewSchema,
    onChange,
  ]);

  if (loading) {
    return <p className="text-sm text-zinc-500">Loading warehouses…</p>;
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-zinc-900">Select resources</h2>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700">SQL warehouse</span>
          <select
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            className="rounded-md border border-zinc-300 px-3 py-2"
          >
            <option value="">Select warehouse…</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.state})
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700">Catalog</span>
          <select
            value={catalog}
            onChange={(e) => setCatalog(e.target.value)}
            disabled={!warehouseId}
            className="rounded-md border border-zinc-300 px-3 py-2 disabled:bg-zinc-50"
          >
            <option value="">Select catalog…</option>
            {catalogs.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700">Source schema</span>
          <select
            value={sourceSchema}
            onChange={(e) => setSourceSchema(e.target.value)}
            disabled={!catalog}
            className="rounded-md border border-zinc-300 px-3 py-2 disabled:bg-zinc-50"
          >
            <option value="">Select source schema…</option>
            {sourceSchemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700">Source table</span>
          <select
            value={sourceTable}
            onChange={(e) => setSourceTable(e.target.value)}
            disabled={!sourceSchema}
            className="rounded-md border border-zinc-300 px-3 py-2 disabled:bg-zinc-50"
          >
            <option value="">Select source table…</option>
            {tables.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-zinc-700">Destination schema</span>
          <select
            value={destSchema}
            onChange={(e) => setDestSchema(e.target.value)}
            disabled={!catalog || createNewSchema}
            className="rounded-md border border-zinc-300 px-3 py-2 disabled:bg-zinc-50"
          >
            <option value="">Select destination schema…</option>
            {destSchemas.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm sm:mt-6">
          <input
            type="checkbox"
            checked={createNewSchema}
            onChange={(e) => {
              setCreateNewSchema(e.target.checked);
              if (e.target.checked) setDestSchema("");
            }}
          />
          <span className="text-zinc-700">Create a new destination schema</span>
        </label>

        {createNewSchema && (
          <label className="flex flex-col gap-1 text-sm sm:col-span-2">
            <span className="font-medium text-zinc-700">New schema name</span>
            <input
              type="text"
              value={destSchema}
              onChange={(e) => setDestSchema(e.target.value)}
              placeholder="metric_views"
              className="rounded-md border border-zinc-300 px-3 py-2"
            />
          </label>
        )}
      </div>
    </section>
  );
}
