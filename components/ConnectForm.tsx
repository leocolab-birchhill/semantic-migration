"use client";

interface CliProfileHint {
  purpose: string;
  profile: string;
  loginCommand: string;
}

interface ConnectFormProps {
  configuredHost: string | null;
  oauthConfigured?: boolean;
  envAuthConfigured?: boolean;
  envAuthError?: string | null;
  cliProfiles?: CliProfileHint[];
  reauthCommand?: string;
  authMode?: "oauth" | "env" | null;
  authenticated: boolean;
  connectedHost: string | null;
  onDisconnect: () => void;
  onRecheck?: () => void;
}

export function ConnectForm({
  configuredHost,
  oauthConfigured = true,
  envAuthConfigured = false,
  envAuthError = null,
  cliProfiles = [],
  reauthCommand = "npm run auth:databricks",
  authMode,
  authenticated,
  connectedHost,
  onDisconnect,
  onRecheck,
}: ConnectFormProps) {
  const defaultHost = configuredHost ?? "https://adb-4200208477969544.4.azuredatabricks.net";

  async function handleConnect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const host = (form.elements.namedItem("host") as HTMLInputElement).value.trim();

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host }),
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error ?? "Failed to start OAuth");
      return;
    }

    window.location.href = data.authorizeUrl;
  }

  async function handleDisconnect() {
    await fetch("/api/auth/logout", { method: "POST" });
    onDisconnect();
  }

  if (authenticated) {
    return (
      <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">Connected</h2>
            <p className="mt-1 text-sm text-zinc-600">{connectedHost}</p>
            {authMode === "env" && (
              <p className="mt-1 text-xs text-zinc-500">
                Using server-side GDI credentials (CLI profile or PAT) — OAuth skipped
              </p>
            )}
          </div>
          {authMode === "oauth" && (
            <button
              type="button"
              onClick={handleDisconnect}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50"
            >
              Disconnect
            </button>
          )}
        </div>
      </section>
    );
  }

  if (envAuthConfigured) {
    return (
      <section className="rounded-lg border border-amber-200 bg-amber-50 p-6 text-sm text-amber-950">
        <p className="font-medium">Databricks CLI auth expired or unreachable</p>
        <p className="mt-2">
          In a terminal, run{" "}
          <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold">
            {reauthCommand}
          </code>{" "}
          (opens browser login if needed), then restart the worker — or use{" "}
          <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold">
            npm run start:local
          </code>{" "}
          to boot auth + app + worker together.
        </p>
        {cliProfiles.length > 0 && (
          <ul className="mt-3 list-inside list-disc space-y-1 text-xs text-amber-900">
            {cliProfiles.map((p) => (
              <li key={p.profile}>
                <span className="font-medium">{p.purpose}</span> profile{" "}
                <code>{p.profile}</code>:{" "}
                <code className="break-all">{p.loginCommand}</code>
              </li>
            ))}
          </ul>
        )}
        {envAuthError && (
          <p className="mt-3 text-xs text-amber-800/80">{envAuthError}</p>
        )}
        {onRecheck && (
          <button
            type="button"
            onClick={onRecheck}
            className="mt-4 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-950 hover:bg-amber-100"
          >
            Re-check auth
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-zinc-900">Connect to Databricks</h2>
      <p className="mt-1 text-sm text-zinc-600">
        Enter your workspace URL. You will be redirected to Databricks to sign in —
        your password is never stored by this app.
      </p>
      <form onSubmit={handleConnect} className="mt-4 flex flex-col gap-3 sm:flex-row">
        <input
          name="host"
          type="url"
          required
          defaultValue={defaultHost}
          placeholder="https://adb-xxx.azuredatabricks.net"
          className="flex-1 rounded-md border border-zinc-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700"
        >
          Connect
        </button>
      </form>
      {!oauthConfigured && (
        <p className="mt-2 text-xs text-amber-700">
          OAuth app not configured — an admin must set DATABRICKS_OAUTH_CLIENT_ID,
          DATABRICKS_OAUTH_CLIENT_SECRET, and DATABRICKS_OAUTH_REDIRECT_URI (one-time app
          registration, not your personal credentials).
        </p>
      )}
    </section>
  );
}
