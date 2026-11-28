import assert from "node:assert/strict";
import { test } from "vitest";
import type { DockerRunner } from "@modainteract/moda-interact-shared/testing/node";
import { startDisposablePostgres } from "../helpers/disposable-postgres";

function dockerFixture(
  port = 25432,
  options: {
    portFailure?: Error;
    readinessFailures?: number;
    cleanupFailure?: Error;
  } = {},
) {
  const calls: string[][] = [];
  let probes = 0;
  let removals = 0;
  const run: DockerRunner = async (args) => {
    calls.push([...args]);
    switch (args[0]) {
      case "run":
        return { stdout: "fixture-container", stderr: "" };
      case "port": {
        if (options.portFailure) throw options.portFailure;
        return { stdout: `127.0.0.1:${port}`, stderr: "" };
      }
      case "exec": {
        if (++probes <= (options.readinessFailures ?? 0))
          throw new Error("not accepting TCP connections yet");
        return { stdout: "127.0.0.1:5432 - accepting connections", stderr: "" };
      }
      case "rm": {
        if (++removals === 1 && options.cleanupFailure)
          throw options.cleanupFailure;
        return { stdout: args.at(-1)!, stderr: "" };
      }
      default:
        throw new Error(`Unexpected Docker command: ${args[0]}`);
    }
  };
  return {
    calls,
    run,
    containerName: () => {
      const command = calls.find((args) => args[0] === "run")!;
      return command[command.indexOf("--name") + 1];
    },
  };
}

test("uses the Shared PostgreSQL lifecycle with explicit pgvector image, loopback port and fixture credentials", async () => {
  const docker = dockerFixture();
  const fixture = await startDisposablePostgres(
    {
      database: "recovery_test",
      user: "recovery_test",
      password: "test_password",
    },
    docker.run,
  );
  try {
    assert.equal(
      fixture.databaseUrl,
      "postgresql://recovery_test:test_password@127.0.0.1:25432/recovery_test",
    );
    const name = docker.containerName();
    assert.match(name, /^moda-test-postgres-/);
    assert.deepEqual(docker.calls, [
      [
        "run",
        "--detach",
        "--name",
        name,
        "--env",
        "POSTGRES_DB=recovery_test",
        "--env",
        "POSTGRES_USER=recovery_test",
        "--env",
        "POSTGRES_PASSWORD=test_password",
        "--publish",
        "127.0.0.1::5432",
        "pgvector/pgvector:pg17",
      ],
      ["port", name, "5432/tcp"],
      [
        "exec",
        name,
        "pg_isready",
        "--username",
        "recovery_test",
        "--dbname",
        "recovery_test",
        "--host",
        "127.0.0.1",
      ],
    ]);
  } finally {
    await fixture.cleanup();
  }
  await fixture.cleanup();
  assert.deepEqual(
    docker.calls.filter((args) => args[0] === "rm"),
    [["rm", "--force", "--volumes", docker.containerName()]],
  );
});

test("independent fixtures get isolated names, credentials and mapped ports", async () => {
  const a = dockerFixture(25432),
    b = dockerFixture(25433);
  const first = await startDisposablePostgres({}, a.run);
  try {
    const second = await startDisposablePostgres({}, b.run);
    try {
      assert.notEqual(a.containerName(), b.containerName());
      const firstUrl = new URL(first.databaseUrl),
        secondUrl = new URL(second.databaseUrl);
      assert.equal(firstUrl.port, "25432");
      assert.equal(secondUrl.port, "25433");
      assert.notEqual(firstUrl.username, secondUrl.username);
      assert.notEqual(firstUrl.password, secondUrl.password);
    } finally {
      await second.cleanup();
    }
  } finally {
    await first.cleanup();
  }
  assert.deepEqual(a.calls.at(-1), [
    "rm",
    "--force",
    "--volumes",
    a.containerName(),
  ]);
  assert.deepEqual(b.calls.at(-1), [
    "rm",
    "--force",
    "--volumes",
    b.containerName(),
  ]);
});

test("waits for the final TCP listener instead of accepting temporary socket readiness", async () => {
  const docker = dockerFixture(25432, { readinessFailures: 1 });
  const fixture = await startDisposablePostgres({}, docker.run);
  try {
    const probes = docker.calls.filter((args) => args[0] === "exec");
    assert.equal(probes.length, 2);
    assert.ok(
      probes.every((args) => args.slice(-2).join(" ") === "--host 127.0.0.1"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("failed startup removes the exact owned container and preserves the original error", async () => {
  const original = new Error("Docker mapped-port query failed");
  const docker = dockerFixture(25432, { portFailure: original });
  await assert.rejects(
    startDisposablePostgres({}, docker.run),
    (error) => error instanceof Error && error.cause === original,
  );
  assert.deepEqual(docker.calls.at(-1), [
    "rm",
    "--force",
    "--volumes",
    docker.containerName(),
  ]);
});

test("failed teardown is reported and a repeated cleanup can finish removing the owned container", async () => {
  const original = new Error("Docker removal failed");
  const docker = dockerFixture(25432, { cleanupFailure: original });
  const fixture = await startDisposablePostgres({}, docker.run);
  await assert.rejects(fixture.cleanup(), (error) => error === original);
  await fixture.cleanup();
  await fixture.cleanup();
  assert.deepEqual(
    docker.calls.filter((args) => args[0] === "rm"),
    [
      ["rm", "--force", "--volumes", docker.containerName()],
      ["rm", "--force", "--volumes", docker.containerName()],
    ],
  );
});
