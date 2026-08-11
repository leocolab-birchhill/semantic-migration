/** Platform-neutral intermediate representation for Looker → Databricks migration */

import type { LookerDynamicField } from "@/lib/migration/dynamic-fields";

export type MigrationJobStatus =
  | "pending"
  | "running"
  | "awaiting_approval"
  | "approved"
  | "published"
  | "failed"
  | "cancelled"
  | "needs_input";

export type MigrationPhase =
  | "inventory"
  | "baseline"
  | "generate"
  | "validate"
  | "deploy_dev"
  | "test"
  | "compare"
  | "diagnose"
  | "patch"
  | "awaiting_approval"
  | "publish"
  | "complete";

export interface IrDimension {
  name: string;
  label?: string;
  type: string;
  sql?: string;
  description?: string;
  hidden?: boolean;
  valueFormat?: string;
  tags?: string[];
}

export interface IrMeasure {
  name: string;
  label?: string;
  type: string;
  sql?: string;
  description?: string;
  valueFormat?: string;
  filters?: string[];
  tags?: string[];
}

export interface IrJoin {
  name: string;
  type: string;
  sqlOn?: string;
  relationship?: string;
  foreignKey?: string;
}

export interface IrFilter {
  name: string;
  type: string;
  defaultValue?: string;
  allowedValues?: string[];
}

export interface IrParameter {
  name: string;
  type: string;
  defaultValue?: string;
  allowedValues?: string[];
}

export interface IrDerivedTable {
  name: string;
  sql?: string;
  exploreSource?: string;
}

export interface IrTileQuery {
  id: string;
  title: string;
  model: string;
  explore: string;
  fields: string[];
  filters?: Record<string, string>;
  /** Looker filter_expression (advanced filter syntax). */
  filterExpression?: string;
  sorts?: string[];
  limit?: number;
  pivots?: string[];
  total?: boolean;
  timezone?: string;
  /** look | dashboard_tile */
  sourceKind?: "look" | "dashboard_tile";
  dashboardId?: string;
  dashboardTitle?: string;
  lookId?: string;
  /** Metric view name this benchmark should validate against (when known). */
  metricViewName?: string;
  /** Dashboard custom measures / dimensions / table calculations. */
  dynamicFields?: LookerDynamicField[];
}

export type DiscoveryConfidence = "high" | "medium" | "low";

export interface DiscoveryEvidence {
  kind:
    | "sql_table_name"
    | "derived_sql"
    | "explore_metadata"
    | "generated_sql"
    | "query_view";
  detail: string;
  path?: string;
}

export interface DiscoveredView {
  name: string;
  model?: string;
  project?: string;
  path?: string;
  confidence: DiscoveryConfidence;
  evidence: DiscoveryEvidence[];
  /** Views are automatic dependencies — always included when confirmed explores use them. */
  role: "automatic_dependency";
}

export interface DiscoveredExplore {
  model: string;
  explore: string;
  label?: string;
  confidence: DiscoveryConfidence;
  evidence: DiscoveryEvidence[];
  viewNames: string[];
  /** Explores are migration units. */
  role: "migration_unit";
}

export interface DiscoveredTile {
  id: string;
  title: string;
  model: string;
  explore: string;
  sourceKind: "look" | "dashboard_tile";
  dashboardId?: string;
  dashboardTitle?: string;
  lookId?: string;
  fields: string[];
  filters?: Record<string, string>;
  filterExpression?: string;
  sorts?: string[];
  limit?: number;
  pivots?: string[];
  total?: boolean;
  timezone?: string;
  confidence: DiscoveryConfidence;
  evidence: DiscoveryEvidence[];
  /** Dashboard/Look tiles are validation benchmarks. */
  role: "validation_benchmark";
  /** Custom measures / dimensions / table calculations from the tile query. */
  dynamicFields?: LookerDynamicField[];
}

export interface TableDiscoveryResult {
  catalog: string;
  schema: string;
  table: string;
  views: DiscoveredView[];
  explores: DiscoveredExplore[];
  tiles: DiscoveredTile[];
  searchedAt: string;
}

/** A Databricks table referenced from Looker LookML / explore metadata. */
export interface LookerReferencedTableSource {
  kind: "lookml_view" | "explore" | "join" | "derived_sql";
  detail: string;
  project?: string;
  path?: string;
  viewName?: string;
  model?: string;
  explore?: string;
}

export interface LookerReferencedTable {
  catalog: string | null;
  schema: string | null;
  table: string;
  /** Lowercased dotted display key. */
  canonical: string;
  sources: LookerReferencedTableSource[];
}

export interface LookerReferencedTablesResult {
  tables: LookerReferencedTable[];
  searchedAt: string;
  truncated: boolean;
  fileCount: number;
}

/** User-confirmed migration scope after discovery. */
export interface ConfirmedMigrationScope {
  sourceTable: {
    catalog: string;
    schema: string;
    table: string;
  };
  /** Confirmed explores to migrate (migration units). */
  explores: Array<{ model: string; explore: string }>;
  /** Optional dashboard/Look tiles used as mandatory parity benchmarks when present. */
  tiles: DiscoveredTile[];
  /** Automatic LookML view dependencies (informational). */
  views: DiscoveredView[];
}

/** Immutable Looker benchmark captured before generation. */
export interface LookerBenchmark {
  tileId: string;
  title: string;
  model: string;
  explore: string;
  sourceKind: "look" | "dashboard_tile";
  queryDefinition: Record<string, unknown>;
  fields: string[];
  filters?: Record<string, string>;
  filterExpression?: string;
  /** Dashboard-level filters applied to the tile, if any. */
  dashboardFilters?: Record<string, string>;
  pivots?: string[];
  sorts?: string[];
  limit?: number;
  timezone?: string;
  generatedSql?: string;
  /** Exact json_bi payload from Looker. */
  jsonBi: unknown;
  rowCount: number;
  capturedAt: string;
  mandatory: true;
  /** Custom measures / dimensions / table calculations used by this tile. */
  dynamicFields?: LookerDynamicField[];
}

export interface IntermediateRepresentation {
  version: string;
  source: {
    type: "explore" | "dashboard" | "table_scope";
    model: string;
    explore: string;
    dashboardId?: string;
    dashboardTitle?: string;
    projectName?: string;
    sourceTable?: { catalog: string; schema: string; table: string };
  };
  grain: {
    primaryKey?: string;
    sqlDistinctKey?: string;
    dimensions: string[];
  };
  joins: IrJoin[];
  dimensions: IrDimension[];
  measures: IrMeasure[];
  filters: IrFilter[];
  parameters: IrParameter[];
  derivedTables: IrDerivedTable[];
  liquidLogic: string[];
  userAttributes: string[];
  formatting: Record<string, string>;
  tileQueries: IrTileQuery[];
  unsupportedFeatures: string[];
  lookmlFiles: Array<{ path: string; contents: string }>;
  /** Confirmed explores when migrating table-first scope. */
  confirmedExplores?: Array<{ model: string; explore: string }>;
  /** Immutable Looker benchmarks captured in baseline phase. */
  benchmarks?: LookerBenchmark[];
  /** Persistent Looker↔Databricks field mapping retained across repair iterations. */
  fieldMapping?: FieldMappingTable;
  /** Deduped dashboard dynamic fields across tiles (formulas for generation). */
  dynamicFields?: LookerDynamicField[];
}

export interface ProposedAsset {
  type: "sql_view" | "metric_view" | "row_filter" | "function" | "dashboard_calc";
  name: string;
  schema: string;
  sql?: string;
  yaml?: string;
  description: string;
  grain?: string;
  /**
   * Persistent Looker→Databricks field mappings for this asset.
   * Required on metric_view assets used for benchmarks.
   */
  fieldMappings?: FieldMappingEntry[];
}

/** Semantic evidence justifying a field mapping (never name similarity alone). */
export interface SemanticMappingEvidence {
  aggregation?: string;
  filters?: string[];
  currency?: string;
  unit?: string;
  populationGrain?: string;
  lookmlSql?: string;
  databricksExpr?: string;
  rationale: string;
}

/** One Looker field → Databricks field mapping declaration. */
export interface FieldMappingEntry {
  /** Source Looker field name (may be explore-prefixed). */
  lookerField: string;
  /** Target metric-view object name. */
  metricViewName: string;
  /** Target Databricks dimension or measure name on that metric view. */
  databricksField: string;
  kind: "dimension" | "measure";
  /** Currency code when applicable (CAD, USD, …). */
  currency?: string;
  /** Unit (currency, count, percent, …). */
  unit?: string;
  /** Population / grain this measure or dimension applies to. */
  populationGrain?: string;
  evidence?: SemanticMappingEvidence;
}

/** Persistent mapping table retained across generate/repair iterations. */
export interface FieldMappingTable {
  version: string;
  entries: FieldMappingEntry[];
  updatedAt: string;
}

/** Parsed metric-view inventory used before benchmark SQL compilation. */
export interface MetricViewInventory {
  name: string;
  source?: string;
  parameters?: Array<{ name: string; data_type: string; default?: unknown }>;
  dimensions: Array<{ name: string; expr?: string }>;
  measures: Array<{ name: string; expr?: string }>;
}

export interface TestCase {
  id: string;
  name: string;
  type:
    | "tile"
    | "measure"
    | "dimension"
    | "filter"
    | "pivot"
    | "total"
    | "null"
    | "timezone"
    | "security"
    | "schema"
    | "smoke";
  lookerQuery: Record<string, unknown>;
  expectedColumns: string[];
  /** When set, comparison is skipped and this status is recorded. */
  skipReason?: string;
  skipStatus?: "inconclusive" | "unsupported";
  /**
   * Mandatory benchmarks must pass for awaiting_approval.
   * Synthetic smoke/baseline tests are never mandatory.
   */
  mandatory?: boolean;
  /** Route this test to a specific metric view asset name. */
  metricViewName?: string;
  /** Use pre-captured Looker json_bi instead of re-running Looker. */
  capturedJsonBi?: unknown;
  capturedLookerSql?: string;
}

export interface ComparisonResult {
  testId: string;
  testName: string;
  status:
    | "pass"
    | "pass_with_boundary_drift"
    | "fail"
    | "error"
    | "inconclusive"
    | "unsupported"
    | "query_compilation_error";
  lookerRowCount: number;
  databricksRowCount: number;
  columnDiffs: Array<{
    column: string;
    lookerValue: unknown;
    databricksValue: unknown;
    match: boolean;
  }>;
  summary: string;
}

export interface FinalAssetSnapshot {
  assets: ProposedAsset[];
  savedAt: string;
}

export interface ParityReport {
  objectsCreated: Array<{ type: string; name: string; schema: string }>;
  measuresTranslated: Array<{ looker: string; databricks: string; notes?: string }>;
  intentionalDifferences: string[];
  multipleViewDecisions: string[];
  securityMappings: string[];
  unsupportedLookerFeatures: string[];
  testsPassed: number;
  testsFailed: number;
  testsInconclusive?: number;
  mandatoryBenchmarksPassed?: number;
  mandatoryBenchmarksFailed?: number;
  mandatoryBenchmarkCount?: number;
  generatedAt: string;
  approvalBlockedReason?: string;
}

export interface MigrationJobRecord {
  id: string;
  tenantId: string;
  userEmail: string | null;
  status: MigrationJobStatus;
  lookerSourceType: string;
  lookerModel: string | null;
  lookerExplore: string | null;
  lookerDashboardId: string | null;
  lookerDashboardTitle: string | null;
  databricksHost: string;
  warehouseId: string;
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
  devSchema: string;
  prodSchema: string | null;
  maxIterations: number;
  decimalScale: number;
  timezone: string;
  currentPhase: MigrationPhase;
  iterationCount: number;
  inventory: IntermediateRepresentation | null;
  parityReport: ParityReport | null;
  migrationScope: ConfirmedMigrationScope | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
}

export interface CreateMigrationJobInput {
  lookerSourceType: "explore" | "dashboard" | "table_scope";
  lookerModel?: string;
  lookerExplore?: string;
  lookerDashboardId?: string;
  databricksHost: string;
  warehouseId: string;
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
  devSchema: string;
  prodSchema?: string;
  maxIterations?: number;
  decimalScale?: number;
  timezone?: string;
  /** Confirmed discovery scope for table-first migrations. */
  migrationScope?: ConfirmedMigrationScope;
  /** Client-generated key so retries/double-clicks reuse one job. */
  idempotencyKey?: string;
}
