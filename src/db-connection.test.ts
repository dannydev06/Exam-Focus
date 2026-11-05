import test from "node:test";
import assert from "node:assert/strict";
import { databasePoolOptions } from "./db-connection.js";

test("database connections use verified TLS for remote hosts", () => {
  assert.deepEqual(databasePoolOptions({ DATABASE_URL: "postgres://user:pass@db.example.test/app" }).ssl, {
    rejectUnauthorized: true,
  });
  assert.deepEqual(databasePoolOptions({ PGHOST: "db.example.test" }).ssl, { rejectUnauthorized: true });
});

test("database connections allow local development hosts without TLS", () => {
  for (const host of ["localhost", "127.0.0.1", "::1", "/var/run/postgresql"]) {
    assert.equal(databasePoolOptions({ PGHOST: host }).ssl, false, host);
  }
});

test("connection URL SSL flags cannot disable verified remote TLS", () => {
  const config = databasePoolOptions({
    DATABASE_URL: "postgres://user:pass@db.example.test/app?sslmode=disable&SSL=true&sslrootcert=%2Ftmp%2Fca.pem",
  });
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.equal(config.connectionString, "postgres://user:pass@db.example.test/app");
});
