import net from "node:net";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { checkPostgresReadiness } from "../../../app/services/health/health-check.server";

/**
 * Focused integration validation for the PostgreSQL readiness probe.
 *
 * A real `pg` driver is used against a local black-hole TCP server that accepts
 * connections but never completes the PostgreSQL protocol handshake.
 *
 * This proves the probe settles via the driver-level connection bound
 * (`connectionTimeoutMillis`) rather than hanging on an unbounded operation.
 *
 * The probe-factory `end()` contract (the probe connection is always released)
 * is covered by unit tests instead of asserted here against TCP half-close
 * semantics, which are timing-dependent.
 */
describe("PostgreSQL readiness probe bounding (integration)", () => {
  let server: net.Server | undefined;
  let sockets: net.Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }

    sockets = [];

    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });

      server = undefined;
    }
  });

  function startBlackHoleServer(): Promise<number> {
    sockets = [];

    server = net.createServer((socket) => {
      sockets.push(socket);

      // Deliberately do not respond. TCP succeeds, but the PostgreSQL
      // startup/authentication handshake never completes.
      socket.on("error", () => {
        // Expected when the client times out/destroys the connection.
      });
    });

    return new Promise<number>((resolve, reject) => {
      server!.once("error", reject);

      server!.listen(0, "127.0.0.1", () => {
        const address = server!.address();

        if (!address || typeof address === "string") {
          reject(new Error("Unable to determine black-hole server port"));
          return;
        }

        resolve(address.port);
      });
    });
  }

  function createBoundedProbe(connectionString: string) {
    return new Client({
      connectionString,

      // Bounds establishing/completing the PostgreSQL connection.
      connectionTimeoutMillis: 200,

      // Bounds query execution after a successful connection.
      query_timeout: 200,

      // Server-side safeguard when connected to a real PostgreSQL server.
      statement_timeout: 200,
    });
  }

  it("settles via the driver-level connection bound and reports not ready", async () => {
    const port = await startBlackHoleServer();

    const startedAt = Date.now();

    const ready = await checkPostgresReadiness(
      `postgresql://probe:probe@127.0.0.1:${port}/probe`,
      createBoundedProbe,
    );

    const elapsed = Date.now() - startedAt;

    expect(ready).toBe(false);

    // The probe really did reach the server; it settled via the driver bound,
    // not an instant local failure.
    expect(sockets.length).toBeGreaterThan(0);

    // It should have waited for the configured driver timeout rather than
    // failing synchronously.
    expect(elapsed).toBeGreaterThanOrEqual(150);

    // Leave generous CI headroom while still proving the probe is bounded.
    expect(elapsed).toBeLessThan(2_000);
  });
});