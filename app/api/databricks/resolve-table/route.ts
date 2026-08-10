import { NextRequest, NextResponse } from "next/server";
import { listCatalogs, listSchemas, listTables } from "@/lib/databricks/client";
import { apiError, requireFields } from "@/lib/api-utils";

/**
 * Resolve a schema.table (often from Looker without catalog) to Unity Catalog
 * location(s) via the selected warehouse.
 */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const missing = requireFields(body, ["warehouseId", "schema", "table"]);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 400 });
    }

    const warehouseId = String(body.warehouseId);
    const schema = String(body.schema);
    const table = String(body.table);
    const preferredCatalog =
      typeof body.catalog === "string" && body.catalog
        ? body.catalog
        : undefined;

    const matches: Array<{ catalog: string; schema: string; table: string }> =
      [];

    const catalogs = preferredCatalog
      ? [preferredCatalog]
      : await listCatalogs(warehouseId);

    for (const catalog of catalogs) {
      let schemas: string[];
      try {
        schemas = await listSchemas(warehouseId, catalog);
      } catch {
        continue;
      }
      const schemaHit = schemas.find(
        (s) => s.toLowerCase() === schema.toLowerCase()
      );
      if (!schemaHit) continue;

      let tables: string[];
      try {
        tables = await listTables(warehouseId, catalog, schemaHit);
      } catch {
        continue;
      }
      const tableHit = tables.find(
        (t) => t.toLowerCase() === table.toLowerCase()
      );
      if (!tableHit) continue;

      matches.push({ catalog, schema: schemaHit, table: tableHit });
    }

    if (matches.length === 0) {
      return NextResponse.json(
        {
          error: `No Unity Catalog match for ${schema}.${table}${
            preferredCatalog ? ` in catalog ${preferredCatalog}` : ""
          }`,
          matches: [],
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      // Prefer exact preferred catalog, else first match
      match: matches[0],
      matches,
    });
  } catch (err) {
    return apiError(err);
  }
}
