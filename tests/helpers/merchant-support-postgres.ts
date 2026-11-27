import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import { startDisposablePostgres, type DisposablePostgres } from "./disposable-postgres";

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

export type MerchantSupportPostgresFixture = {
  databaseUrl: string;
  database: QueryLoggingPrismaClient;
  createClient(applicationName: string): QueryLoggingPrismaClient;
  cleanup(): Promise<void>;
};

export async function startMerchantSupportPostgresFixture(): Promise<MerchantSupportPostgresFixture> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const postgres: DisposablePostgres = await startDisposablePostgres({
    database: `support_${suffix}`,
    user: `support_${suffix}`,
    password: `test_${randomUUID().replaceAll("-", "")}`,
  });
  const databaseUrl = postgres.databaseUrl;
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
    await postgres.cleanup();
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
  const database = createClient(`support-${suffix}-main`);
  try {
    await database.$connect();
  } catch (error) {
    await Promise.allSettled([...clients].map(client => client.$disconnect()));
    await postgres.cleanup();
    throw error;
  }

  return {
    databaseUrl,
    database,
    createClient,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await Promise.allSettled([...clients].map((client) => client.$disconnect()));
      await postgres.cleanup();
    },
  };
}
