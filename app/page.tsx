import { Suspense } from "react";
import Home from "./home-client";

export default function Page() {
  return (
    <Suspense fallback={<p className="p-8 text-sm text-zinc-500">Loading…</p>}>
      <Home />
    </Suspense>
  );
}
