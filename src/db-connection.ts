import { isIP } from "node:net";
import type { PoolConfig } from "pg";

function isLocalDatabaseHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const ipVersion = isIP(normalized);
  return normalized === "localhost" || normalized.endsWith(".localhost") ||
    normalized.startsWith("/") || (ipVersion === 4 && normalized.startsWith("127.")) ||
    (ipVersion === 6 && (normalized === "::1" || normalized.startsWith("::ffff:127.")));
}

export function databasePoolOptions(env: Partial<Pick<NodeJS.ProcessEnv, "DATABASE_URL" | "PGHOST">> = process.env): PoolConfig {
  const url = env.DATABASE_URL ? new URL(env.DATABASE_URL) : null;
  const host = url?.hostname || env.PGHOST || "localhost";
  if (url) {
    const sslOptions = new Set(["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert"]);
    for (const key of [...url.searchParams.keys()])
      if (sslOptions.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return {
    ...(url ? { connectionString: url.toString() } : {}),
    ssl: isLocalDatabaseHost(host) ? false : { rejectUnauthorized: true },
  };
}
