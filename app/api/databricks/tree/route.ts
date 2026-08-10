import { NextRequest, NextResponse } from "next/server";
import { listCatalogs, listSchemas, listTables } from "@/lib/databricks/client";
import { apiError, requireFields } from "@/lib/api-utils";
import type { ExplorerNode } from "@/lib/explorer-types";

export async function GET(request: NextRequest) {
  try {
    const warehouseId = request.nextUrl.searchParams.get("warehouseId");
    const path = request.nextUrl.searchParams.get("path") ?? "";

    const missing = requireFields({ warehouseId }, ["warehouseId"]);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    const nodes: ExplorerNode[] = [];

    if (!path) {
      const catalogs = await listCatalogs(warehouseId!);
      nodes.push(
        ...catalogs.map((c) => ({
          id: `catalog:${c}`,
          name: c,
          type: "catalog" as const,
          path: c,
          hasChildren: true,
        }))
      );
      return NextResponse.json({ nodes });
    }

    const parts = path.split("/");

    if (parts.length === 1) {
      const catalog = parts[0];
      const schemas = await listSchemas(warehouseId!, catalog);
      nodes.push(
        ...schemas.map((s) => ({
          id: `schema:${catalog}/${s}`,
          name: s,
          type: "schema" as const,
          path: `${catalog}/${s}`,
          hasChildren: true,
          meta: { catalog, schema: s },
        }))
      );
      return NextResponse.json({ nodes });
    }

    if (parts.length === 2) {
      const [catalog, schema] = parts;
      const tables = await listTables(warehouseId!, catalog, schema);
      nodes.push(
        ...tables.map((t) => ({
          id: `table:${catalog}/${schema}/${t}`,
          name: t,
          type: "table" as const,
          path: `${catalog}/${schema}/${t}`,
          hasChildren: false,
          meta: { catalog, schema, table: t },
        }))
      );
      return NextResponse.json({ nodes });
    }

    return NextResponse.json({ nodes: [] });
  } catch (err) {
    return apiError(err);
  }
}
