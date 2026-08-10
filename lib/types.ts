export interface TenantConfig {
  id: string;
  host: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface PermissionCheckResult {
  id: string;
  label: string;
  status: "pass" | "fail" | "skipped" | "pending";
  message: string;
  missingGrant?: string;
  error?: string;
}

export interface PermissionAssessment {
  checks: PermissionCheckResult[];
  allPassed: boolean;
}

export interface WarehouseInfo {
  id: string;
  name: string;
  state: string;
}

export interface ResourceSelection {
  warehouseId: string;
  catalog: string;
  sourceSchema: string;
  sourceTable: string;
  destSchema: string;
  createNewSchema: boolean;
}

export const OAUTH_SCOPES = "sql offline_access openid email profile";
