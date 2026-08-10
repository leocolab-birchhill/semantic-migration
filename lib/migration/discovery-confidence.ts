import type { DiscoveryConfidence, DiscoveryEvidence } from "@/lib/migration/types";

const RANK: Record<DiscoveryConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

export function maxConfidence(
  a: DiscoveryConfidence,
  b: DiscoveryConfidence
): DiscoveryConfidence {
  return RANK[a] >= RANK[b] ? a : b;
}

export function confidenceFromEvidence(
  evidence: DiscoveryEvidence[]
): DiscoveryConfidence {
  if (evidence.some((e) => e.kind === "sql_table_name")) return "high";
  if (evidence.some((e) => e.kind === "derived_sql")) return "high";
  if (evidence.some((e) => e.kind === "generated_sql")) return "medium";
  if (evidence.some((e) => e.kind === "explore_metadata")) return "medium";
  if (evidence.some((e) => e.kind === "query_view")) return "low";
  return "low";
}
