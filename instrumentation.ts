/**
 * Next may evaluate this file for both Node and Edge.
 * Only load dotenv / path under the Node.js runtime.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const [{ default: dotenv }, path] = await Promise.all([
    import("dotenv"),
    import("path"),
  ]);

  dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
  dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });
}
