import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

const execFileAsync = promisify(execFile);
export type QueryLoggingPrismaClient = PrismaClient<{
  log: [{ emit: "event"; level: "query" }];
}>;
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const prismaExecutable = resolve(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "prisma.cmd" : "prisma",
);

export type BillingPostgresFixture = {
  databaseUrl: string;
  database: QueryLoggingPrismaClient;
  createClient(applicationName: string): QueryLoggingPrismaClient;
  cleanup(): Promise<void>;
};

export async function startBillingPostgresFixture(): Promise<BillingPostgresFixture> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const postgres: StartedPostgreSqlContainer = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withDatabase(`billing_${suffix}`)
    .withUsername(`billing_${suffix}`)
    .withPassword(`test_${randomUUID().replaceAll("-", "")}`)
    .start();
  const databaseUrl = postgres.getConnectionUri();
  const clients = new Set<PrismaClient>();
  let cleaned = false;

  try {
    await execFileAsync(
      prismaExecutable,
      ["migrate", "deploy", "--schema", "database/prisma/schema.prisma"],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
  } catch (error) {
    await postgres.stop();
    throw error;
  }

  const createClient = (applicationName: string) => {
    const url = new URL(databaseUrl);
    url.searchParams.set("application_name", applicationName);
    const client: QueryLoggingPrismaClient = new PrismaClient({
      datasourceUrl: url.toString(),
      log: [{ emit: "event", level: "query" }],
    });
    clients.add(client);
    return client;
  };
  const database = createClient(`billing-${suffix}-main`);
  await database.$connect();

  return {
    databaseUrl,
    database,
    createClient,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await Promise.allSettled([...clients].map((client) => client.$disconnect()));
      await postgres.stop();
    },
  };
}
