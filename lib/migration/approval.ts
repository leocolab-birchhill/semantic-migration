import type { TestCase } from "@/lib/migration/types";

export interface ApprovalGateInput {
  mandatoryTests: TestCase[];
  mandatoryPassed: number;
  mandatoryFailed: number;
  /** Passes that came from synthetic (non-mandatory) tests only. */
  evidencePasses: number;
  failed: number;
  /** Optional breakdown for clearer user-facing copy. */
  unsupportedCount?: number;
  compileErrorCount?: number;
  /** Databricks statement failures at run time (CAST errors, bad predicates) — not value mismatches. */
  sqlErrorCount?: number;
}

/**
 * awaiting_approval requires:
 * - when dashboard/Look tile benchmarks exist: every runnable mandatory must pass
 * - when none were selected (explore-only migration): allow approval if smoke/evidence
 *   tests passed (parity is weaker — no tile proof)
 * Unsupported / skipped tiles (pivots, missing fields) do not block approval.
 */
export function evaluateApprovalGate(input: ApprovalGateInput): {
  canApprove: boolean;
  blockedReason?: string;
} {
  const mandatoryCount = input.mandatoryTests.filter((t) => !t.skipStatus).length;

  if (mandatoryCount === 0) {
    if (input.evidencePasses > 0 && input.failed === 0) {
      return { canApprove: true };
    }
    if (input.evidencePasses > 0) {
      return {
        canApprove: false,
        blockedReason:
          "Can't publish yet: no dashboard/Look tiles were selected, and some smoke/schema checks still failed. Fix those or add tile benchmarks for stronger parity proof.",
      };
    }
    return {
      canApprove: false,
      blockedReason:
        "Can't publish yet: no dashboard/Look tiles were selected and smoke tests have not passed. Re-run tests, or add tile benchmarks when available.",
    };
  }

  if (input.mandatoryFailed > 0) {
    const compile = input.compileErrorCount ?? 0;
    const sqlErrors = input.sqlErrorCount ?? 0;
    const valueFails = Math.max(0, input.mandatoryFailed - compile - sqlErrors);
    const unsupported = input.unsupportedCount ?? 0;

    const segments: string[] = [];
    if (compile > 0) {
      segments.push(
        `${compile} tile${compile === 1 ? "" : "s"} couldn't be translated to a metric-view query (field-mapping / compile issue)`
      );
    }
    if (sqlErrors > 0) {
      segments.push(
        `${sqlErrors} tile${sqlErrors === 1 ? "" : "s"} hit a SQL error when the query ran against Databricks (bad compiled filter or expression — not a value mismatch)`
      );
    }
    if (valueFails > 0) {
      segments.push(
        `${valueFails} tile${valueFails === 1 ? "" : "s"} returned different values than Looker`
      );
    }
    if (segments.length === 0) {
      segments.push(
        `${input.mandatoryFailed} required tile${input.mandatoryFailed === 1 ? "" : "s"} did not pass`
      );
    }
    let reason = `Can't publish yet: ${segments.join("; ")} — see Coverage gaps below`;
    if (unsupported > 0) {
      reason += `. Separately, ${unsupported} tile${unsupported === 1 ? "" : "s"} are outside current auto-migration support (e.g. pivots) and are tracked as gaps, not publish blockers.`;
    }
    return { canApprove: false, blockedReason: reason };
  }

  if (input.mandatoryPassed < mandatoryCount) {
    return {
      canApprove: false,
      blockedReason:
        "Can't publish yet: not every required dashboard tile matched Looker. See Coverage gaps below.",
    };
  }

  return { canApprove: true };
}

export function withApprovalFields(
  report: import("@/lib/migration/types").ParityReport,
  gate: ReturnType<typeof evaluateApprovalGate>,
  mandatory: { passed: number; failed: number; count: number }
): import("@/lib/migration/types").ParityReport {
  return {
    ...report,
    mandatoryBenchmarksPassed: mandatory.passed,
    mandatoryBenchmarksFailed: mandatory.failed,
    mandatoryBenchmarkCount: mandatory.count,
    approvalBlockedReason: gate.canApprove
      ? undefined
      : gate.blockedReason ?? report.approvalBlockedReason,
  };
}

export function benchmarksToMandatoryTests(
  benchmarks: import("@/lib/migration/types").LookerBenchmark[]
): TestCase[] {
  return benchmarks.map((b) => ({
    id: `benchmark_${b.tileId}`,
    name: b.title,
    type: "tile" as const,
    lookerQuery: b.queryDefinition,
    expectedColumns: b.fields,
    mandatory: true,
    capturedJsonBi: b.jsonBi,
    capturedLookerSql: b.generatedSql,
  }));
}
