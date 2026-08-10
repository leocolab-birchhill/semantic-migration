"use client";

import { useCallback, useEffect, useState } from "react";
import type { ExplorerNode } from "@/lib/explorer-types";

interface FileTreeProps {
  title: string;
  loadChildren: (path: string) => Promise<ExplorerNode[]>;
  onSelect?: (node: ExplorerNode) => void;
  rootLabel?: string;
}

const TYPE_ICONS: Record<ExplorerNode["type"], string> = {
  root: "📁",
  catalog: "🗂️",
  schema: "📂",
  table: "📋",
  model: "📦",
  explore: "🔍",
  view: "👁",
  dashboard: "📊",
  project: "📁",
  folder: "📂",
  file: "📄",
};

export function FileTree({
  title,
  loadChildren,
  onSelect,
  rootLabel = "root",
}: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["root"]));
  const [children, setChildren] = useState<Record<string, ExplorerNode[]>>({});
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rootLoaded, setRootLoaded] = useState(false);

  const fetchChildren = useCallback(
    async (path: string, nodeId: string) => {
      if (children[nodeId]) return;
      setLoading((prev) => new Set(prev).add(nodeId));
      setError(null);
      try {
        const nodes = await loadChildren(path);
        setChildren((prev) => ({ ...prev, [nodeId]: nodes }));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
      }
    },
    [children, loadChildren]
  );

  useEffect(() => {
    if (!rootLoaded) {
      fetchChildren("", "root").then(() => setRootLoaded(true));
    }
  }, [rootLoaded, fetchChildren]);

  async function toggle(node: ExplorerNode) {
    const nodeId = node.id;
    if (node.hasChildren) {
      const isExpanded = expanded.has(nodeId);
      if (!isExpanded) {
        await fetchChildren(node.path ?? "", nodeId);
        setExpanded((prev) => new Set(prev).add(nodeId));
      } else {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
      }
    }
    setSelectedId(nodeId);
    onSelect?.(node);
  }

  function renderNode(node: ExplorerNode, depth = 0) {
    const isExpanded = expanded.has(node.id);
    const isLoading = loading.has(node.id);
    const nodeChildren = children[node.id] ?? [];
    const showChildren = isExpanded && nodeChildren.length > 0;

    return (
      <div key={node.id}>
        <button
          type="button"
          onClick={() => toggle(node)}
          className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm hover:bg-zinc-100 ${
            selectedId === node.id ? "bg-orange-50 text-orange-900" : "text-zinc-800"
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <span className="w-4 text-xs text-zinc-400">
            {node.hasChildren ? (isExpanded ? "▾" : "▸") : "·"}
          </span>
          <span>{TYPE_ICONS[node.type]}</span>
          <span className="truncate">{node.name}</span>
          {isLoading && <span className="text-xs text-zinc-400">…</span>}
        </button>
        {showChildren && nodeChildren.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  const rootNode: ExplorerNode = {
    id: "root",
    name: rootLabel,
    type: "root",
    path: "",
    hasChildren: true,
  };

  return (
    <div className="flex h-full min-h-[360px] flex-col rounded-lg border border-zinc-200 bg-white">
      <div className="border-b border-zinc-100 px-3 py-2 text-sm font-semibold text-zinc-800">
        {title}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {error && <p className="px-2 py-1 text-xs text-red-600">{error}</p>}
        {renderNode(rootNode)}
        {loading.has("root") && (
          <p className="px-3 py-2 text-xs text-zinc-500">Loading…</p>
        )}
      </div>
    </div>
  );
}
