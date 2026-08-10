import { NextResponse } from "next/server";
import { listModels } from "@/lib/looker/client";
import { apiError } from "@/lib/api-utils";

export async function GET() {
  try {
    const models = await listModels();
    return NextResponse.json({ models });
  } catch (err) {
    return apiError(err);
  }
}
