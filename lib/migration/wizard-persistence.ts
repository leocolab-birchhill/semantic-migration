import type {
  MigrationJobRecord,
  TableDiscoveryResult,
} from "@/lib/migration/types";

const STORAGE_KEY = "vra.migration.wizard.v1";

export type WizardStep = "source" | "discover" | "review";

export interface PersistedWizardState {
  step: WizardStep;
  discovery: TableDiscoveryResult | null;
  selectedExplores: string[];
  selectedTiles: string[];
  activeJobId: string | null;
  devSchema: string;
  prodSchema: string;
  /** Table key this discovery belongs to: catalog.schema.table */
  sourceKey: string | null;
  /** Enough to restore Databricks selection after remount */
  databricks?: {
    warehouseId: string;
    catalog: string;
    sourceSchema: string;
    sourceTable: string;
    destSchema: string;
    prodSchema?: string;
  } | null;
  updatedAt: string;
}

function sourceKeyFrom(
  catalog: string,
  schema: string,
  table: string
): string {
  return `${catalog}.${schema}.${table}`;
}

export function wizardSourceKey(sel: {
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
}): string {
  return sourceKeyFrom(sel.catalog, sel.sourceSchema, sel.sourceTable);
}

export function loadWizardState(): PersistedWizardState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedWizardState;
  } catch {
    return null;
  }
}

export function saveWizardState(state: PersistedWizardState): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...state, updatedAt: new Date().toISOString() })
    );
  } catch {
    // Quota / private mode — ignore
  }
}

export function clearWizardState(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function patchWizardState(
  patch: Partial<PersistedWizardState>
): void {
  const current = loadWizardState();
  saveWizardState({
    step: "source",
    discovery: null,
    selectedExplores: [],
    selectedTiles: [],
    activeJobId: null,
    devSchema: "semantic_migration_dev",
    prodSchema: "business_semantics",
    sourceKey: null,
    databricks: null,
    updatedAt: new Date().toISOString(),
    ...current,
    ...patch,
  });
}

export type { MigrationJobRecord };
