"use client";



import { useCallback, useEffect, useState } from "react";

import { useSearchParams } from "next/navigation";

import { DatabricksPanel } from "@/components/DatabricksPanel";

import { LookerPanel } from "@/components/LookerPanel";

import {

  MigrationPanel,

  type DatabricksSelection,

  type LookerSelection,

} from "@/components/MigrationPanel";



type Tab = "looker" | "databricks" | "migration";



export default function Home() {

  const searchParams = useSearchParams();

  const [tab, setTab] = useState<Tab>("migration");

  const [authenticated, setAuthenticated] = useState(false);

  const [connectedHost, setConnectedHost] = useState<string | null>(null);

  const [configuredHost, setConfiguredHost] = useState<string | null>(null);

  const [userEmail, setUserEmail] = useState<string | null>(null);

  const [oauthConfigured, setOauthConfigured] = useState(true);

  const [envAuthConfigured, setEnvAuthConfigured] = useState(false);

  const [envAuthError, setEnvAuthError] = useState<string | null>(null);

  const [cliProfiles, setCliProfiles] = useState<
    Array<{ purpose: string; profile: string; loginCommand: string }>
  >([]);

  const [reauthCommand, setReauthCommand] = useState("npm run auth:databricks");

  const [authMode, setAuthMode] = useState<"oauth" | "env" | null>(null);

  const [banner, setBanner] = useState<string | null>(null);

  const [lookerSelection, setLookerSelection] = useState<LookerSelection | null>(

    null

  );

  const [databricksSelection, setDatabricksSelection] =

    useState<DatabricksSelection | null>(null);



  const refreshStatus = useCallback(() => {

    fetch("/api/auth/status")

      .then((res) => res.json())

      .then((data) => {

        setAuthenticated(Boolean(data.authenticated));

        setConnectedHost(data.host ?? null);

        setConfiguredHost(data.configuredHost ?? null);

        setOauthConfigured(data.oauthConfigured !== false);

        setEnvAuthConfigured(Boolean(data.envAuthConfigured));

        setEnvAuthError(data.envAuthError ?? null);

        setCliProfiles(Array.isArray(data.cliProfiles) ? data.cliProfiles : []);

        setReauthCommand(data.reauthCommand ?? "npm run auth:databricks");

        setAuthMode(data.authMode ?? null);

        setUserEmail(data.userEmail ?? null);

      });

  }, []);



  useEffect(() => {

    refreshStatus();

    const error = searchParams.get("error");

    const connected = searchParams.get("connected");

    if (error) setBanner(decodeURIComponent(error));

    if (connected) {

      setBanner("Successfully connected to Databricks");

      refreshStatus();

    }

  }, [searchParams, refreshStatus]);



  const tabs: { id: Tab; label: string }[] = [

    { id: "migration", label: "Migration" },

    { id: "looker", label: "Looker explorer" },

    { id: "databricks", label: "Databricks connection" },

  ];



  return (

    <div className="min-h-full bg-zinc-50">

      <header className="border-b border-zinc-200 bg-white">

        <div className="mx-auto max-w-6xl px-4 py-6">

          <div className="flex items-center justify-between">

            <div>

              <h1 className="text-2xl font-bold text-zinc-900">

                Looker → Databricks Migration

              </h1>

              <p className="mt-1 text-sm text-zinc-600">

                Table-first: pick a Databricks source table, discover Looker

                dependencies, confirm Explores (tiles optional), then reconcile

              </p>

            </div>

            {authenticated && userEmail && (

              <p className="text-sm text-zinc-500">Signed in as {userEmail}</p>

            )}

          </div>

        </div>

      </header>



      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">

        {banner && (

          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">

            {banner}

            <button

              type="button"

              className="ml-3 underline"

              onClick={() => setBanner(null)}

            >

              dismiss

            </button>

          </div>

        )}



        {!authenticated && envAuthConfigured && (

          <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">

            Databricks CLI auth needs a refresh. Run{" "}

            <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold">

              {reauthCommand}

            </code>{" "}

            in a terminal (or{" "}

            <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold">

              npm run start:local

            </code>{" "}

            to boot everything), then use the Databricks tab → Re-check auth.

          </div>

        )}



        {!authenticated && !envAuthConfigured && (

          <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">

            Sign in via the Databricks tab to start a migration.

          </div>

        )}



        <div className="flex gap-2">

          {tabs.map((t) => (

            <button

              key={t.id}

              type="button"

              onClick={() => setTab(t.id)}

              className={`rounded-md px-4 py-2 text-sm font-medium ${

                tab === t.id

                  ? "bg-zinc-900 text-white"

                  : "border border-zinc-300 text-zinc-700 hover:bg-zinc-50"

              }`}

            >

              {t.label}

            </button>

          ))}

        </div>



        {tab === "migration" && (

          <MigrationPanel

            authenticated={authenticated}

            connectedHost={connectedHost}

            lookerSelection={lookerSelection}

            databricksSelection={databricksSelection}

            onDatabricksSelectionChange={setDatabricksSelection}

            onRestoreSelections={({ looker, databricks, prodSchema }) => {

              setLookerSelection(looker);

              setDatabricksSelection({

                ...databricks,

                prodSchema: prodSchema ?? databricks.prodSchema,

              });

            }}

          />

        )}



        {tab === "looker" && (

          <LookerPanel onSelectionChange={setLookerSelection} />

        )}



        {tab === "databricks" && (

          <DatabricksPanel

            authenticated={authenticated}

            connectedHost={connectedHost}

            configuredHost={configuredHost}

            oauthConfigured={oauthConfigured}

            envAuthConfigured={envAuthConfigured}

            envAuthError={envAuthError}

            cliProfiles={cliProfiles}

            reauthCommand={reauthCommand}

            authMode={authMode}

            onDisconnect={() => {

              setAuthenticated(false);

              setConnectedHost(null);

              setUserEmail(null);

            }}

            onRecheckAuth={refreshStatus}

            onSelectionChange={setDatabricksSelection}

            destSchemaOverride={databricksSelection?.destSchema}

            prodSchemaOverride={databricksSelection?.prodSchema}

          />

        )}

      </main>

    </div>

  );

}


