import { NextResponse } from "next/server";
import { DatabricksApiError } from "@/lib/databricks/client";
import { LookerApiError } from "@/lib/looker/client";

export function apiError(err: unknown, fallback = "Request failed") {
  if (err instanceof DatabricksApiError || err instanceof LookerApiError) {
    return NextResponse.json(
      {
        error: err.message,
        status: err.status,
        details: err.body,
      },
      { status: err.status >= 400 && err.status < 600 ? err.status : 500 }
    );
  }
  const message = err instanceof Error ? err.message : fallback;
  return NextResponse.json({ error: message }, { status: 500 });
}

export function requireFields<T extends Record<string, unknown>>(
  body: T,
  fields: (keyof T)[]
): string | null {
  for (const field of fields) {
    const value = body[field];
    if (value === undefined || value === null || value === "") {
      return `Missing required field: ${String(field)}`;
    }
  }
  return null;
}
