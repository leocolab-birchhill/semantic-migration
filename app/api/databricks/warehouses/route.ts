import { NextResponse } from "next/server";
import { listWarehouses } from "@/lib/databricks/client";
import { apiError } from "@/lib/api-utils";

export async function GET() {
  try {
    const warehouses = await listWarehouses();
    return NextResponse.json({ warehouses });
  } catch (err) {
    return apiError(err);
  }
}
