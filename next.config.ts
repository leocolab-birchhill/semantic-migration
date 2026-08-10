import type { NextConfig } from "next";
import dotenv from "dotenv";
import path from "path";

// Load .envs (user convention) then standard Next.js env files
dotenv.config({ path: path.resolve(process.cwd(), ".envs") });
dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

const nextConfig: NextConfig = {
  /* config options here */
};

export default nextConfig;
