"use client";

import { useMemo } from "react";
import {
  buildParityPreview,
  type RowSet,
} from "@/lib/migration/comparator";
import type { MigrationReport } from "@/lib/migration/report";

export interface ScorecardTestRow {
  test_name: string;
  status: string;
  diff_summary?: string | null;
  iteration_id?: string | null;
  looker_result?: unknown;
  databricks_result?: unknown;
  looker_query?: unknown;
}

function asRowSet(value: unknown): RowSet | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(obj.columns) || !Array.isArray(obj.rows)) return null;
  return {
    columns: obj.columns.map(String),
    rows: obj.rows as unknown[][],
  };
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? value.toLocaleString()
      : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  const n = Number(String(value).replace(/,/g, ""));
  if (
    String(value).trim() !== "" &&
    Number.isFinite(n) &&
    /e/i.test(String(value))
  ) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  if (
    String(value).trim() !== "" &&
    Number.isFinite(n) &&
    !Number.isNaN(n) &&
    /^-?\d/.test(String(value).trim())
  ) {
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  return String(value);
}

function statusLabel(status: string): string {
  switch (status) {
    case "pass":
    case "recreated":
      return "Exact match";
    case "pass_with_boundary_drift":
    case "close_match":
      return "Close match";
    case "fail":
    case "mismatch":
      return "Mismatch";
    case "unsupported":
      return "Unsupported";
    case "query_compilation_error":
    case "compile_error":
      return "Compile error";
    case "inconclusive":
      return "Inconclusive";
    default:
      return status.replace(/_/g, " ");
  }
}

function statusClass(status: string): string {
  if (status === "pass" || status === "recreated") return "text-green-700";
  if (status === "pass_with_boundary_drift" || status === "close_match")
    return "text-emerald-700";
  if (status === "fail" || status === "mismatch" || status === "error")
    return "text-red-700";
  return "text-amber-700";
}

function hasSorts(lookerQuery: unknown): boolean {
  if (!lookerQuery || typeof lookerQuery !== "object") return false;
  const sorts = (lookerQuery as { sorts?: unknown }).sorts;
  return Array.isArray(sorts) && sorts.length > 0;
}

/**
 * Non-technical parity scorecard: Looker tile values vs Databricks metric-view
 * results, plus how to use the deployed view in Databricks.
 */
export function ParityScorecard({
  report,
  tests,
  databricksHost,
  catalog,
  devSchema,
}: {
  report: MigrationReport | null;
  tests: ScorecardTestRow[];
  databricksHost: string;
  catalog: string;
  devSchema: string;
}) {
  const latest = useMemo(() => {
    let latestId: string | null = null;
    for (const t of tests) {
      if (t.iteration_id) latestId = t.iteration_id;
    }
    return latestId ? tests.filter((t) => t.iteration_id === latestId) : tests;
  }, [tests]);

  const tilesWithPreview = useMemo(() => {
    return latest
      .filter((t) =>
        [
          "pass",
          "pass_with_boundary_drift",
          "fail",
          "inconclusive",
        ].includes(t.status)
      )
      .map((t) => {
        const looker = asRowSet(t.looker_result);
        const db = asRowSet(t.databricks_result);
        const preview =
          looker && db
            ? buildParityPreview(looker, db, 4)
            : null;
        return { ...t, preview, sorted: hasSorts(t.looker_query) };
      });
  }, [latest]);

  const scorecard = report?.scorecard;
  const metricViews =
    report?.writtenToDatabricks.filter((o) => o.type === "metric_view") ?? [];
  const host = databricksHost.replace(/^https?:\/\//, "");
  const schemaUrl = `https://${host}/explore/data/${catalog}/${devSchema}`;

  if (!report && latest.length === 0) return null;

  return (
    <div className="mt-5 space-y-3 rounded-md border border-zinc-200 bg-white p-4">
      <div>
        <h4 className="text-sm font-semibold text-zinc-900">
          Does the new metric view match Looker?
        </h4>
        <p className="mt-1 text-sm text-zinc-700">
          {scorecard?.verdict ??
            "Tile benchmarks compare Looker dashboard values to the same metrics queried from the Databricks metric view."}
        </p>
        {scorecard && (
          <p className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">
            {scorecard.accuracyPercent}%
            <span className="ml-2 text-sm font-normal text-zinc-500">
              usable vs Looker
              {scorecard.closeMatches > 0
                ? ` · ${scorecard.exactMatches} exact · ${scorecard.closeMatches} close`
                : ` · ${scorecard.exactMatches} exact`}
            </span>
          </p>
        )}
        <p className="mt-2 text-xs text-zinc-500">
          This section shows tiles that ran a Looker ↔ Databricks value
          comparison. Gaps that never ran (pivots, missing fields, compile
          errors) are listed in <strong>Semantic layer coverage</strong> below.
        </p>
      </div>

      {tilesWithPreview.length > 0 && (
        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
            Looker tile vs Databricks metric view
          </h5>
          <ul className="mt-2 divide-y divide-zinc-100 rounded-md border border-zinc-100">
            {tilesWithPreview.map((t, i) => {
              const p = t.preview;
              const isListIssue =
                p &&
                (p.mismatchKind === "list_membership" ||
                  p.mismatchKind === "unordered_sample");
              return (
                <li
                  key={`${t.iteration_id ?? "x"}-${t.test_name}-${i}`}
                  className="px-3 py-2.5"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-zinc-900">
                      {t.test_name}
                    </span>
                    <span
                      className={`text-xs font-semibold ${statusClass(t.status)}`}
                    >
                      {statusLabel(t.status)}
                    </span>
                  </div>

                  {p && (
                    <p className="mt-1 text-xs text-zinc-700">{p.why}</p>
                  )}

                  {p && (p.lookerOnlyCount > 0 || p.databricksOnlyCount > 0) && (
                    <p className="mt-1 text-xs text-zinc-500">
                      Overlap: {p.sharedCount} shared
                      {p.lookerOnlyCount > 0
                        ? ` · ${p.lookerOnlyCount} only in Looker`
                        : ""}
                      {p.databricksOnlyCount > 0
                        ? ` · ${p.databricksOnlyCount} only in Databricks`
                        : ""}
                      {!t.sorted ? " · tile has no sort (unstable top-N)" : ""}
                    </p>
                  )}

                  {t.diff_summary && !p && (
                    <p className="mt-0.5 text-xs text-zinc-500">
                      {t.diff_summary.length > 220
                        ? `${t.diff_summary.slice(0, 220)}…`
                        : t.diff_summary}
                    </p>
                  )}

                  {p && p.rows.length > 0 && (
                    <div className="mt-2 overflow-x-auto">
                      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                        {p.measureDiffCount > 0
                          ? "Value differences (and samples)"
                          : "Sample shared rows (values match)"}
                      </p>
                      <table className="w-full min-w-[28rem] text-left text-xs">
                        <thead>
                          <tr className="text-zinc-500">
                            <th className="py-1 pr-3 font-medium">
                              Metric / row
                            </th>
                            <th className="py-1 pr-3 font-medium">Looker</th>
                            <th className="py-1 pr-3 font-medium">
                              Databricks
                            </th>
                            <th className="py-1 font-medium"> </th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.rows.map((row) => (
                            <tr
                              key={`${row.kind}-${row.label}`}
                              className="border-t border-zinc-50"
                            >
                              <td className="py-1 pr-3 text-zinc-700">
                                {row.label}
                              </td>
                              <td className="py-1 pr-3 font-mono text-zinc-900">
                                {formatCell(row.lookerValue)}
                              </td>
                              <td className="py-1 pr-3 font-mono text-zinc-900">
                                {formatCell(row.databricksValue)}
                              </td>
                              <td className="py-1">
                                {row.match ? (
                                  <span className="text-green-600">✓</span>
                                ) : (
                                  <span className="text-red-600">≠</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {isListIssue &&
                    (p.lookerOnlySample.length > 0 ||
                      p.databricksOnlySample.length > 0) && (
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {p.lookerOnlySample.length > 0 && (
                          <div className="rounded border border-amber-100 bg-amber-50/70 px-2 py-1.5">
                            <p className="text-[11px] font-semibold uppercase text-amber-800">
                              Only in Looker sample
                            </p>
                            <ul className="mt-1 space-y-0.5 text-xs text-amber-950/90">
                              {p.lookerOnlySample.map((name) => (
                                <li key={name}>{name}</li>
                              ))}
                              {p.lookerOnlyCount > p.lookerOnlySample.length && (
                                <li className="text-amber-800/70">
                                  +{p.lookerOnlyCount - p.lookerOnlySample.length}{" "}
                                  more
                                </li>
                              )}
                            </ul>
                          </div>
                        )}
                        {p.databricksOnlySample.length > 0 && (
                          <div className="rounded border border-sky-100 bg-sky-50/70 px-2 py-1.5">
                            <p className="text-[11px] font-semibold uppercase text-sky-800">
                              Only in Databricks sample
                            </p>
                            <ul className="mt-1 space-y-0.5 text-xs text-sky-950/90">
                              {p.databricksOnlySample.map((name) => (
                                <li key={name}>{name}</li>
                              ))}
                              {p.databricksOnlyCount >
                                p.databricksOnlySample.length && (
                                <li className="text-sky-800/70">
                                  +
                                  {p.databricksOnlyCount -
                                    p.databricksOnlySample.length}{" "}
                                  more
                                </li>
                              )}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <h5 className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
          How to use this in Databricks
        </h5>
        <ol className="mt-1 list-decimal space-y-1 pl-4 text-sm text-zinc-700">
          {(scorecard?.howToUse ?? [
            `Open schema ${catalog}.${devSchema} in Catalog Explorer.`,
            "Query the metric view with MEASURE() in a SQL warehouse.",
            "Build an AI/BI dashboard on top of that metric view in Databricks (not auto-created by this app yet).",
          ]).map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="mt-3 flex flex-wrap gap-2">
          <a
            href={schemaUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
          >
            Open Databricks schema
          </a>
          {metricViews.map((mv) => (
            <a
              key={mv.fqn}
              href={`https://${host}/explore/data/${catalog}/${devSchema}/${mv.name}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-800 hover:bg-zinc-50"
            >
              Open {mv.name}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
