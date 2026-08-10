export interface ExplorerNode {
  id: string;
  name: string;
  type:
    | "root"
    | "catalog"
    | "schema"
    | "table"
    | "model"
    | "explore"
    | "view"
    | "dashboard"
    | "project"
    | "folder"
    | "file";
  path?: string;
  hasChildren?: boolean;
  meta?: Record<string, string>;
}
