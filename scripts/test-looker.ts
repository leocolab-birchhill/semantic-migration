import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".envs") });

import { getModel, listModels, listViews } from "../lib/looker/client";

async function main() {
  const models = await listModels();
  console.log("models:", models.length, models.map((m) => m.name).join(", "));

  const gdi = models.find((m) => m.name.toLowerCase() === "gdi");
  if (!gdi) {
    console.log("gdi model not found");
    return;
  }

  const modelDetail = await getModel(gdi.name);
  console.log("explores:", (modelDetail.explores ?? []).length);

  const views = await listViews(gdi.name);
  console.log("views:", views.length, views.slice(0, 8).map((v) => v.name).join(", "));
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
