/**
 * Typed dependency graph + atomic migration component contracts.
 * Inventory-first planning: exhaustively inventory; selectively migrate.
 */

export type GraphNodeType =
  | "source"
  | "transformation"
  | "derived_table"
  | "looker_view"
  | "semantic_field"
  | "explore"
  | "consumer"
  | "security_policy"
  | "databricks_asset";

export type GraphEdgeType =
  | "builds_from"
  | "depends_on"
  | "joins"
  | "extends"
  | "refines"
  | "consumes"
  | "governed_by"
  | "maps_to"
  | "includes_available";

/** How a dependency was established. */
export type DependencyEvidenceKind =
  | "confirmed"
  | "statically_inferred"
  | "runtime_observed"
  | "availability_only"
  | "unresolved"
  | "dynamic";

export type CouplingStrength = "hard" | "soft" | "incidental";

export type ScopeMode = "consumer-parity" | "explore-retirement";

export type OrdinalRating = "low" | "medium" | "high";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  /** Stable identity keys — never match on bare name alone. */
  identity: {
    project?: string;
    model?: string;
    file?: string;
    connection?: string;
    catalog?: string;
    schema?: string;
    object?: string;
    explore?: string;
    field?: string;
    consumerKind?: "dashboard" | "look" | "schedule" | "api" | "embedded" | "other";
  };
  metadata?: Record<string, unknown>;
  flags?: {
    hidden?: boolean;
    deprecated?: boolean;
    dynamicSql?: boolean;
    liquid?: boolean;
    userAttributeDeps?: boolean;
    manyToMany?: boolean;
    fanOutRisk?: boolean;
    aggregateAware?: boolean;
    unsupportedTarget?: boolean;
  };
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: GraphEdgeType;
  evidence: DependencyEvidenceKind;
  coupling?: CouplingStrength;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface GraphIssue {
  kind:
    | "cycle"
    | "orphan"
    | "unresolved_reference"
    | "dynamic_sql"
    | "liquid"
    | "user_attribute"
    | "many_to_many"
    | "fan_out"
    | "aggregate_awareness"
    | "hidden_or_deprecated"
    | "unsupported_target";
  severity: "info" | "warn" | "error";
  nodeIds: string[];
  message: string;
}

export interface DependencyGraph {
  version: string;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  issues: GraphIssue[];
}

export interface EnvironmentInventorySummary {
  projects: number;
  models: number;
  files: number;
  explores: number;
  views: number;
  fields: number;
  joins: number;
  derivedTables: number;
  dashboards: number;
  looks: number;
  schedules: number;
  sources: number;
  databricksAssets: number;
  unavailable: string[];
  unresolvedDependencies: string[];
}

export interface InventoryLookmlFile {
  project: string;
  path: string;
  /** LookML text — never store credentials. */
  contents: string;
}

export interface InventoryExplore {
  project?: string;
  model: string;
  explore: string;
  label?: string;
  viewName?: string;
  sqlTableName?: string;
  joins: Array<{
    name: string;
    type?: string;
    sqlOn?: string;
    relationship?: string;
    foreignKey?: string;
  }>;
  dimensions: Array<{
    name: string;
    type?: string;
    sql?: string;
    hidden?: boolean;
    description?: string;
  }>;
  measures: Array<{
    name: string;
    type?: string;
    sql?: string;
    hidden?: boolean;
    description?: string;
  }>;
  filters?: Array<{ name: string; type?: string }>;
  parameters?: Array<{ name: string; type?: string }>;
  accessGrants?: string[];
  alwaysFilters?: unknown[];
}

export interface InventoryView {
  project: string;
  path?: string;
  name: string;
  sqlTableName?: string;
  derivedTableSql?: string;
  extends?: string[];
  refined?: boolean;
  fields?: Array<{ name: string; kind: "dimension" | "measure" | "filter" | "parameter" }>;
}

export interface InventoryConsumer {
  id: string;
  kind: "dashboard" | "look" | "schedule" | "api" | "embedded" | "other";
  title: string;
  model?: string;
  explore?: string;
  fields?: string[];
  schedule?: string;
  owner?: string;
}

export interface InventorySource {
  catalog: string | null;
  schema: string | null;
  table: string;
  canonical: string;
}

export interface InventoryDatabricksAsset {
  id: string;
  kind: "table" | "view" | "metric_view" | "other";
  catalog?: string;
  schema?: string;
  name: string;
  label?: string;
}

/**
 * Exhaustive environment snapshot used to build the dependency graph.
 * Secrets/tokens must never appear here.
 */
export interface EnvironmentInventory {
  version: string;
  generatedAt: string;
  projects: Array<{ id: string; name: string }>;
  models: Array<{ name: string; project: string; label?: string | null }>;
  files: InventoryLookmlFile[];
  explores: InventoryExplore[];
  views: InventoryView[];
  consumers: InventoryConsumer[];
  sources: InventorySource[];
  databricksAssets: InventoryDatabricksAsset[];
  summary: EnvironmentInventorySummary;
  notes?: string[];
}

export interface AcceptanceTestSpec {
  description: string;
  tolerance?: string;
}

export interface ComponentManifest {
  id: string;
  name: string;
  business_domain: string;
  scope_mode: ScopeMode;
  grain: string;
  root_explores: string[];
  selected_consumers: string[];
  includes: {
    views: string[];
    fields: string[];
    joins: string[];
    transformations: string[];
    security_policies: string[];
  };
  source_assets: string[];
  target_assets: string[];
  depends_on_components: string[];
  excluded: string[];
  deferred: string[];
  unresolved_dependencies: string[];
  acceptance_tests: AcceptanceTestSpec[];
  risks: string[];
  owner: string | null;
  confidence: OrdinalRating;
  rationale: string;
  /** Planning-only scoring (ordinal, not fake precision). */
  scores?: {
    business_value: OrdinalRating;
    usage: OrdinalRating;
    data_readiness: OrdinalRating;
    owner_availability: OrdinalRating;
    testability: OrdinalRating;
    semantic_complexity: OrdinalRating;
    unsupported_features: OrdinalRating;
    security_complexity: OrdinalRating;
    dependency_burden: OrdinalRating;
    migration_risk: OrdinalRating;
  };
  node_ids?: string[];
  is_foundation?: boolean;
  atomic?: boolean;
  atomicity_failures?: string[];
}

export interface MigrationWave {
  wave: number;
  label: string;
  component_ids: string[];
  justification: string;
}

export interface ComponentPlan {
  version: string;
  generatedAt: string;
  scope_mode_default: ScopeMode;
  inventory_summary: EnvironmentInventorySummary;
  components: ComponentManifest[];
  waves: MigrationWave[];
  recommended_first: string | null;
  questions: string[];
  graph_artifact_path?: string;
  mermaid_summary_path?: string;
}
