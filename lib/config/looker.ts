export interface LookerConfig {
  host: string;
  clientId: string;
  clientSecret: string;
}

function env(key: string, alt?: string): string | undefined {
  return process.env[key] ?? (alt ? process.env[alt] : undefined);
}

export function getLookerConfig(): LookerConfig | null {
  const host = env("LOOKER_HOST", "Looker_HOST");
  const clientId = env("LOOKER_CLIENT_ID", "Looker_Client_ID");
  const clientSecret = env("LOOKER_CLIENT_SECRET", "Looker_Client_Secret");

  if (!host || !clientId || !clientSecret) return null;

  return {
    host: host.replace(/\/+$/, ""),
    clientId,
    clientSecret,
  };
}

export function getOpenAiKey(): string | undefined {
  return env("OPENAI_API_KEY");
}
