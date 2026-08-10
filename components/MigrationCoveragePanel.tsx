"use client";

import { useMemo, useState } from "react";
import type { MigrationReport } from "@/lib/migration/report";
import type { ScorecardTestRow } from "@/components/ParityScorecard";

type GapKind =
  | "matched"
  | "close"
  | "needs_fix"
  | "platform_gap"
  | "looker_gap"
  | "other";

interface CoverageItem {
  name: string;
  status: string;
  summary: string;
  kind: GapKind;
  plainWhy: string;
  nextStep: string;
}

function classify(status: string, summary: string): Omit<CoverageItem, "name" | "status" | "summary"> {
  const s = summary.toLowerCase();

  if (status === "pass" || status === "recreated") {
    return {
      kind: "matched",
      plainWhy: "Looker and Databricks returned matching values for this tile.",
      nextStep: "Ready to use from the metric view.",
    };
  }
  if (status === "pass_with_boundary_drift" || status === "close_match") {
    return {
      kind: "close",
      plainWhy:
        "Metric values match on shared rows; only the top-N entity list drifts (ties / sort), not the measure math.",
      nextStep: "Treat as usable; tighten Looker sorts if you need identical ranked lists.",
    };
  }
  if (status === "unsupported" || s.includes("pivot")) {
    if (s.includes("pivot") && !s.includes("unsupported")) {
      return {
        kind: "close",
        plainWhy:
          "This Looker tile used pivots. The app compares values with pivot fields as normal GROUP BY columns (not Looker pivot chrome).",
        nextStep:
          "If numbers match, rebuild the pivot layout in Databricks SQL / AI/BI on the same measures.",
      };
    }
    if (s.includes("pivot")) {
      return {
        kind: "platform_gap",
        plainWhy:
          "This Looker tile uses pivots. Databricks metric views don’t auto-clone pivoted tile layouts; value parity may still run with pivot dims as columns.",
        nextStep:
          "Keep the measure in the metric view; rebuild the pivot in a Databricks SQL warehouse query or AI/BI dashboard.",
      };
    }
    if (s.includes("missing") || s.includes("not present")) {
      return {
        kind: "looker_gap",
        plainWhy:
          "The dashboard references field names that aren't in the Looker explore inventory and weren't captured as dashboard dynamic fields (custom measures / table calcs).",
        nextStep:
          "Re-discover with dynamic_fields enabled, confirm the field in LookML, or accept as out of scope if obsolete.",
      };
    }
    return {
      kind: "platform_gap",
      plainWhy: summary || "This tile uses a Looker pattern the migrator does not auto-translate yet.",
      nextStep: "Recreate manually on the metric view, or adjust the Looker tile and rerun.",
    };
  }
  if (
    status === "query_compilation_error" ||
    status === "compile_error" ||
    s.includes("query_compilation_error")
  ) {
    if (s.includes("ambiguous_currency") || s.includes("currency")) {
      return {
        kind: "needs_fix",
        plainWhy:
          "Field-mapping metadata treated a ratio/percentage as a currency while Looker treats it as dimensionless — or a stale CAD tag remained on the mapping.",
        nextStep:
          "Rerun the migration: the app now auto-clears currency on share/margin/percent measures. If it persists, inspect the field mapping artifact.",
      };
    }
    return {
      kind: "needs_fix",
      plainWhy:
        summary ||
        "The migrator could not compile a valid Databricks query for this tile from the current field mapping.",
      nextStep: "See the compile error detail, fix mapping / expressions, and rerun.",
    };
  }
  if (status === "fail" || status === "mismatch") {
    if (
      s.includes("coalesce") ||
      s.includes("null vs") ||
      s.includes("looker 0 vs databricks null")
    ) {
      return {
        kind: "needs_fix",
        plainWhy:
          summary ||
          "Looker returns 0 for empty aggregates while Databricks MEASURE() returns null for the same groups.",
        nextStep:
          "Wrap the measure expr in COALESCE(expr, 0) and rerun — the app also applies this when diffs are clearly null↔0.",
      };
    }
    return {
      kind: "needs_fix",
      plainWhy: summary || "Looker and Databricks returned different values for this tile.",
      nextStep: "Inspect column diffs, patch measure expr/filters, and rerun.",
    };
  }
  if (status === "error") {
    if (/TABLE_OR_VIEW_NOT_FOUND/i.test(s)) {
      return {
        kind: "needs_fix",
        plainWhy:
          summary ||
          "Databricks could not find the metric view (or its source) when running the test query — often the metric-view source does not point at the job's SQL view.",
        nextStep:
          "Confirm the metric view exists in the write schema and its YAML source is catalog.dev_schema.<sql_view>, then rerun.",
      };
    }
    return {
      kind: "needs_fix",
      plainWhy:
        summary ||
        "The compiled Databricks query failed to run (SQL error).",
      nextStep:
        "Open technical detail for the Databricks error, fix the SQL/source, and rerun.",
    };
  }
  return {
    kind: "other",
    plainWhy: summary || "Could not fully compare this check.",
    nextStep: "Review detail and decide whether it is in scope.",
  };
}

function kindLabel(kind: GapKind): string {
  switch (kind) {
    case "matched":
      return "Migrated & matching";
    case "close":
      return "Migrated & close match";
    case "needs_fix":
      return "Needs a fix to migrate";
    case "platform_gap":
      return "Platform gap (Looker feature)";
    case "looker_gap":
      return "Looker inventory gap";
    default:
      return "Other";
  }
}

function ExpandableGroup({
  title,
  hint,
  items,
  defaultOpen,
}: {
  title: string;
  hint: string;
  items: CoverageItem[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  if (items.length === 0) return null;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="rounded-md border border-zinc-200 bg-white"
    >
      <summary className="cursor-pointer list-none px-3 py-2.5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-semibold text-zinc-900">
            {title}{" "}
            <span className="font-normal text-zinc-500">({items.length})</span>
          </span>
          <span className="text-xs text-zinc-500">{open ? "Hide" : "Show"}</span>
        </div>
        <p className="mt-0.5 text-xs text-zinc-600">{hint}</p>
      </summary>
      <ul className="divide-y divide-zinc-100 border-t border-zinc-100">
        {items.map((item, i) => (
          <li key={`${item.name}-${item.status}-${i}`} className="px-3 py-2.5">
            <p className="text-sm font-medium text-zinc-900">{item.name}</p>
            <p className="mt-1 text-xs text-zinc-700">{item.plainWhy}</p>
            <p className="mt-1 text-xs text-zinc-500">
              <span className="font-medium text-zinc-600">Next: </span>
              {item.nextStep}
            </p>
            {item.summary && item.summary !== item.plainWhy && (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[11px] text-zinc-400 hover:text-zinc-600">
                  Technical detail
                </summary>
                <p className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-zinc-500">
                  {item.summary}
                </p>
              </details>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * User-facing coverage report: what made it into Databricks vs what didn't and why.
 */
export function MigrationCoveragePanel({
  report,
  tests,
}: {
  report: MigrationReport | null;
  tests: ScorecardTestRow[];
}) {
  const items = useMemo(() => {
    // Schema coverage is informational inventory metadata, not a tile check.
    const isInfoCheck = (name: string) => name === "Semantic schema coverage";
    if (report?.tiles?.length) {
      return report.tiles
        .filter((t) => !isInfoCheck(t.name))
        .map((t) => {
          const c = classify(t.status, t.summary);
          return { name: t.name, status: t.status, summary: t.summary, ...c };
        });
    }
    let latestId: string | null = null;
    for (const t of tests) {
      if (t.iteration_id) latestId = t.iteration_id;
    }
    const slice = latestId
      ? tests.filter((t) => t.iteration_id === latestId)
      : tests;
    return slice
      .filter((t) => !isInfoCheck(t.test_name))
      .map((t) => {
        const c = classify(t.status, t.diff_summary ?? "");
        return {
          name: t.test_name,
          status: t.status,
          summary: t.diff_summary ?? "",
          ...c,
        };
      });
  }, [report, tests]);

  if (items.length === 0 && !report) return null;

  const matched = items.filter((i) => i.kind === "matched");
  const close = items.filter((i) => i.kind === "close");
  const needsFix = items.filter((i) => i.kind === "needs_fix");
  const platform = items.filter((i) => i.kind === "platform_gap");
  // Inventory gaps are no longer first-class — hide from coverage (legacy rows → other).
  const other = items.filter(
    (i) => i.kind === "other" || i.kind === "looker_gap"
  );

  const usable = matched.length + close.length;
  const gapCount = needsFix.length + platform.length + other.length;
  const written = report?.writtenToDatabricks ?? [];

  return (
    <div className="mt-5 space-y-3 rounded-md border border-zinc-200 bg-white p-4">
      <div>
        <h4 className="text-sm font-semibold text-zinc-900">
          Semantic layer coverage
        </h4>
        <p className="mt-1 text-sm text-zinc-700">
          High-level view of what this job wrote to Databricks, which Looker
          dashboard tiles it could prove match, and what is still a gap — with
          plain-language reasons (not raw test status codes).
        </p>
        <p className="mt-2 text-2xl font-semibold tracking-tight text-zinc-900">
          {usable}
          <span className="text-sm font-normal text-zinc-500">
            {" "}
            / {items.length} tiles usable
          </span>
          {gapCount > 0 && (
            <span className="ml-2 text-sm font-normal text-amber-800">
              · {gapCount} gap{gapCount === 1 ? "" : "s"}
            </span>
          )}
        </p>
      </div>

      <div className="rounded-md border border-sky-100 bg-sky-50/60 px-3 py-2 text-xs text-sky-950">
        <p className="font-semibold">Looker vs Databricks — what “migrated” means</p>
        <p className="mt-1 text-sky-900/90">
          Looker explores are a BI semantic layer (dimensions, measures, joins,
          dashboard tiles). This app recreates that as a Databricks{" "}
          <strong>SQL base view + metric view</strong> — measures you can query
          with <code className="rounded bg-sky-100 px-1">MEASURE()</code>. Looker
          labels, descriptions, tags, and value formats are written into metric-view
          agent metadata (<code className="rounded bg-sky-100 px-1">display_name</code>,{" "}
          <code className="rounded bg-sky-100 px-1">comment</code>,{" "}
          <code className="rounded bg-sky-100 px-1">synonyms</code>,{" "}
          <code className="rounded bg-sky-100 px-1">format</code>) for Genie / AI/BI.
          It does not clone Looker’s full dashboard chrome. Currency/ratio metadata is
          auto-repaired in-app (so CAD CASE branches inside share/margin exprs
          don’t false-block). Pivoted Looker tiles are validated as{" "}
          <strong>value parity with pivot dims as columns</strong> — rebuild the
          pivot layout later in Databricks SQL / AI/BI if you need the same UI.
        </p>
      </div>

      {written.length > 0 && (
        <div>
          <h5 className="text-xs font-semibold uppercase tracking-wide text-zinc-600">
            Written to Databricks
          </h5>
          <ul className="mt-1 space-y-1 text-sm text-zinc-800">
            {written.map((o) => (
              <li key={o.fqn}>
                <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] uppercase text-zinc-600">
                  {o.type}
                </span>{" "}
                <span className="font-mono text-xs">{o.fqn}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2">
        <ExpandableGroup
          title={kindLabel("needs_fix")}
          hint="These block publishing until fixed — usually mapping / compile issues."
          items={needsFix}
          defaultOpen
        />
        <ExpandableGroup
          title={kindLabel("platform_gap")}
          hint="Looker presentation features. Pivots are validated as unpivoted value parity when possible; rebuild layout in Databricks AI/BI."
          items={platform}
          defaultOpen
        />
        <ExpandableGroup
          title={kindLabel("matched")}
          hint="Proven to match Looker values."
          items={matched}
        />
        <ExpandableGroup
          title={kindLabel("close")}
          hint="Measure math matches; ranked entity lists differ slightly."
          items={close}
        />
        <ExpandableGroup
          title={kindLabel("other")}
          hint="Could not fully classify this check."
          items={other}
        />
      </div>

      <p className="text-[11px] text-zinc-500">
        Coverage focuses on the explore semantic layer being migrated (inventory
        dims/measures + captured dynamic fields). Dashboard tiles are used only to
        test those fields — tile-only names outside the explore are ignored.
        Unsupported presentation gaps are tracked above but no longer count as
        publish failures by themselves.
      </p>
    </div>
  );
}
