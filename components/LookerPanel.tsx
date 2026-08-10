"use client";

import { useCallback, useEffect, useState } from "react";
import { FileTree } from "@/components/FileTree";
import type { ExplorerNode } from "@/lib/explorer-types";

import type { LookerSelection } from "@/components/MigrationPanel";

interface LookerPanelProps {
  onSelectContent?: (title: string, content: string) => void;
  onSelectionChange?: (selection: LookerSelection) => void;
}

export function LookerPanel({ onSelectContent, onSelectionChange }: LookerPanelProps) {
  const [status, setStatus] = useState<{
    configured: boolean;
    host: string | null;
    missing: string[];
  } | null>(null);
  const [mode, setMode] = useState<"semantic" | "files" | "dashboards">("semantic");
  const [detail, setDetail] = useState<string>("");
  const [detailTitle, setDetailTitle] = useState<string>("");

  useEffect(() => {
    fetch("/api/looker/status")
      .then((r) => r.json())
      .then(setStatus);
  }, []);

  const loadSemantic = useCallback(async (path: string): Promise<ExplorerNode[]> => {
    if (!path) {
      const res = await fetch("/api/looker/models");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load models");
      return (data.models ?? []).map(
        (m: { name: string; label: string | null; project_name: string }) => ({
          id: `model:${m.name}`,
          name: m.label ?? m.name,
          type: "model" as const,
          path: m.name,
          hasChildren: true,
          meta: { project: m.project_name },
        })
      );
    }

    if (!path.includes("/")) {
      const res = await fetch(`/api/looker/models/${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load model");

      return [
        {
          id: `folder:${path}/explores`,
          name: "Explores",
          type: "folder" as const,
          path: `${path}/explores`,
          hasChildren: true,
          meta: { model: path, kind: "explores" },
        },
        {
          id: `folder:${path}/views`,
          name: "Views",
          type: "folder" as const,
          path: `${path}/views`,
          hasChildren: true,
          meta: { model: path, kind: "views" },
        },
      ];
    }

    const parts = path.split("/");
    if (parts.length === 2 && parts[1] === "explores") {
      const res = await fetch(`/api/looker/models/${encodeURIComponent(parts[0])}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      return (data.explores ?? []).map(
        (e: { name: string; label: string | null }) => ({
          id: `explore:${parts[0]}/${e.name}`,
          name: e.label ?? e.name,
          type: "explore" as const,
          path: `${parts[0]}/explores/${e.name}`,
          hasChildren: false,
          meta: { model: parts[0], explore: e.name },
        })
      );
    }

    if (parts.length === 2 && parts[1] === "views") {
      const res = await fetch(`/api/looker/models/${encodeURIComponent(parts[0])}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      return (data.views ?? []).map((v: { name: string; label: string | null }) => ({
        id: `view:${parts[0]}/${v.name}`,
        name: v.label ?? v.name,
        type: "view" as const,
        path: `${parts[0]}/views/${v.name}`,
        hasChildren: false,
        meta: { model: parts[0], view: v.name },
      }));
    }

    return [];
  }, []);

  const loadProjectFiles = useCallback(async (path: string): Promise<ExplorerNode[]> => {
    if (!path) {
      const res = await fetch("/api/looker/projects");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load projects");
      return (data.projects ?? []).map((p: { id: string; name: string }) => ({
        id: `project:${p.id}`,
        name: p.name,
        type: "project" as const,
        path: p.id,
        hasChildren: true,
        meta: { projectId: p.id },
      }));
    }

    const parts = path.split("/");
    const projectId = parts[0];
    const filePath = parts.slice(1).join("/");

    const res = await fetch(
      `/api/looker/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(filePath)}`
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load files");

    return (data.files ?? []).map((f: { path: string; type: string; extension?: string }) => {
      const isFolder = f.type === "dir" || f.type === "directory";
      const name = f.path.split("/").pop() ?? f.path;
      const fullPath = `${projectId}/${f.path}`;
      return {
        id: `file:${fullPath}`,
        name,
        type: isFolder ? ("folder" as const) : ("file" as const),
        path: fullPath,
        hasChildren: isFolder,
        meta: { projectId, filePath: f.path, extension: f.extension ?? "" },
      };
    });
  }, []);

  const loadDashboards = useCallback(async (): Promise<ExplorerNode[]> => {
    const res = await fetch("/api/looker/dashboards");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Failed to load dashboards");
    return (data.dashboards ?? []).map(
      (d: { id: string; title: string; description: string | null }) => ({
        id: `dashboard:${d.id}`,
        name: d.title,
        type: "dashboard" as const,
        path: d.id,
        hasChildren: false,
        meta: { dashboardId: d.id, dashboardTitle: d.title },
      })
    );
  }, []);

  async function handleSelect(node: ExplorerNode) {
    if (node.type === "explore" && node.meta?.model && node.meta?.explore) {
      const res = await fetch(
        `/api/looker/models/${encodeURIComponent(node.meta.model)}/explores/${encodeURIComponent(node.meta.explore)}`
      );
      const data = await res.json();
      const json = JSON.stringify(data.detail, null, 2);
      setDetailTitle(`Explore: ${node.meta.model}.${node.meta.explore}`);
      setDetail(json);
      onSelectContent?.(`Explore: ${node.meta.model}.${node.meta.explore}`, json);
      onSelectionChange?.({
        type: "explore",
        model: node.meta.model,
        explore: node.meta.explore,
        label: `${node.meta.model}.${node.meta.explore}`,
      });
    } else if (node.type === "dashboard" && node.meta?.dashboardId) {
      const res = await fetch(
        `/api/looker/dashboards/${encodeURIComponent(node.meta.dashboardId)}`
      );
      const data = await res.json();
      const json = JSON.stringify(data.dashboard, null, 2);
      setDetailTitle(`Dashboard: ${node.meta.dashboardTitle ?? node.meta.dashboardId}`);
      setDetail(json);
      onSelectContent?.(`Dashboard: ${node.meta.dashboardTitle}`, json);
      onSelectionChange?.({
        type: "dashboard",
        dashboardId: node.meta.dashboardId,
        dashboardTitle: node.meta.dashboardTitle,
        label: node.meta.dashboardTitle ?? node.meta.dashboardId,
      });
    } else if (node.type === "view" && node.meta?.model && node.meta?.view) {
      const res = await fetch(
        `/api/looker/models/${encodeURIComponent(node.meta.model)}/views/${encodeURIComponent(node.meta.view)}`
      );
      const data = await res.json();
      const json = JSON.stringify(data.detail, null, 2);
      setDetailTitle(`View: ${node.meta.model}.${node.meta.view}`);
      setDetail(json);
      onSelectContent?.(`View: ${node.meta.model}.${node.meta.view}`, json);
    } else if (node.type === "file" && node.meta?.projectId && node.meta?.filePath) {
      const res = await fetch(
        `/api/looker/projects/${encodeURIComponent(node.meta.projectId)}/files?path=${encodeURIComponent(node.meta.filePath)}&content=1`
      );
      const data = await res.json();
      const text = data.file?.contents ?? "";
      setDetailTitle(node.meta.filePath);
      setDetail(text);
      onSelectContent?.(node.meta.filePath, text);
    }
  }

  if (!status) {
    return <p className="text-sm text-zinc-500">Checking Looker configuration…</p>;
  }

  if (!status.configured) {
    return (
      <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">Looker not configured</p>
        <p className="mt-1">
          Set {status.missing.join(", ")} in your environment (e.g. .env.local).
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Looker</h2>
          <p className="text-sm text-zinc-600">Connected to {status.host}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("semantic")}
            className={`rounded-md px-3 py-1.5 text-sm ${mode === "semantic" ? "bg-zinc-900 text-white" : "border border-zinc-300"}`}
          >
            Models & explores
          </button>
          <button
            type="button"
            onClick={() => setMode("dashboards")}
            className={`rounded-md px-3 py-1.5 text-sm ${mode === "dashboards" ? "bg-zinc-900 text-white" : "border border-zinc-300"}`}
          >
            Dashboards
          </button>
          <button
            type="button"
            onClick={() => setMode("files")}
            className={`rounded-md px-3 py-1.5 text-sm ${mode === "files" ? "bg-zinc-900 text-white" : "border border-zinc-300"}`}
          >
            Project files (.lkml)
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2" style={{ minHeight: "420px" }}>
        <FileTree
          title={
            mode === "semantic"
              ? "Semantic layer"
              : mode === "dashboards"
                ? "Dashboards"
                : "LookML files"
          }
          loadChildren={
            mode === "semantic"
              ? loadSemantic
              : mode === "dashboards"
                ? loadDashboards
                : loadProjectFiles
          }
          onSelect={handleSelect}
          rootLabel={
            mode === "semantic" ? "Models" : mode === "dashboards" ? "Dashboards" : "Projects"
          }
        />
        <div className="flex flex-col rounded-lg border border-zinc-200 bg-white">
          <div className="border-b border-zinc-100 px-3 py-2 text-sm font-semibold text-zinc-800">
            {detailTitle || "Preview"}
          </div>
          <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs text-zinc-700">
            {detail || "Select an explore, view, or LookML file"}
          </pre>
        </div>
      </div>
    </div>
  );
}
