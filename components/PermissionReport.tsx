"use client";

import type { PermissionAssessment, PermissionCheckResult } from "@/lib/types";

interface PermissionReportProps {
  assessment: PermissionAssessment | null;
  loading: boolean;
  onRunChecks: () => void;
  onRunProbe: () => void;
  probeLoading: boolean;
  canRun: boolean;
}

function StatusBadge({ status }: { status: PermissionCheckResult["status"] }) {
  const styles = {
    pass: "bg-green-100 text-green-800",
    fail: "bg-red-100 text-red-800",
    skipped: "bg-zinc-100 text-zinc-600",
    pending: "bg-amber-100 text-amber-800",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${styles[status]}`}>
      {status}
    </span>
  );
}

export function PermissionReport({
  assessment,
  loading,
  onRunChecks,
  onRunProbe,
  probeLoading,
  canRun,
}: PermissionReportProps) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900">Permission assessment</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Read-only checks first. Run a write probe only when you need definitive
            CREATE/DROP validation.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!canRun || loading}
            onClick={onRunChecks}
            className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
          >
            {loading ? "Running…" : "Run checks"}
          </button>
          <button
            type="button"
            disabled={!canRun || probeLoading}
            onClick={onRunProbe}
            className="rounded-md border border-amber-500 px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
          >
            {probeLoading ? "Probing…" : "Run write probe"}
          </button>
        </div>
      </div>

      {assessment && (
        <div className="mt-4 space-y-3">
          <p
            className={`text-sm font-medium ${assessment.allPassed ? "text-green-700" : "text-red-700"}`}
          >
            {assessment.allPassed
              ? "All applicable checks passed"
              : "Some checks failed — review missing grants below"}
          </p>
          <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
            {assessment.checks.map((check) => (
              <li key={check.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-zinc-900">{check.label}</p>
                    <p className="mt-0.5 text-sm text-zinc-600">{check.message}</p>
                    {check.missingGrant && (
                      <p className="mt-1 text-sm text-red-700">
                        Request: <code className="text-xs">{check.missingGrant}</code>
                      </p>
                    )}
                    {check.error && (
                      <p className="mt-1 text-xs text-red-600">{check.error}</p>
                    )}
                  </div>
                  <StatusBadge status={check.status} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
