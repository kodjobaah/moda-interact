import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";
import {
  startDisposablePostgres,
  type DisposablePostgres,
} from "./disposable-postgres";
import { Session } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { ShopService } from "../../app/services/shop/shop.service";
import { createCoordinatedShopifyAuthentication } from "../../app/services/shopify-offline-coordination.server";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const prismaExecutable = resolve(repositoryRoot, "node_modules/.bin/prisma");

export type LifecyclePostgres = {
  prefix: string;
  primary: PrismaClient;
  second: PrismaClient;
  observer: PrismaClient;
  queryLog: string[];
  storage: PrismaSessionStorage<PrismaClient>;
  storageSecond: PrismaSessionStorage<PrismaClient>;
  service(client?: PrismaClient): ShopService;
  createShop(
    suffix: string,
    status?: "ACTIVE" | "UNINSTALLED",
  ): Promise<{ id: string; domain: string }>;
  session(
    shop: string,
    id: string,
    token?: string,
    expires?: Date | null,
    refreshToken?: string | null,
  ): Session;
  stop(): Promise<void>;
};

export async function startLifecyclePostgres(
  testName: string,
): Promise<LifecyclePostgres> {
  let container: DisposablePostgres | undefined;
  try {
    container = await startDisposablePostgres({
      database: "shopify_lifecycle_test",
      user: "shopify_lifecycle_test",
      password: `test_${randomUUID().replaceAll("-", "")}`,
    });
  } catch (error) {
    throw new Error(
      `Unable to start required disposable PostgreSQL 17 container for ${testName}`,
      { cause: error },
    );
  }
  const databaseUrl = container.databaseUrl;
  const clients: PrismaClient[] = [];
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
    const queryLog: string[] = [];
    const clientOptions = {
      datasourceUrl: databaseUrl,
      log: [{ emit: "event" as const, level: "query" as const }],
    };
    const primary = new PrismaClient(clientOptions);
    const second = new PrismaClient(clientOptions);
    const observer = new PrismaClient(clientOptions);
    clients.push(primary, second, observer);
    primary.$on("query", (event) => queryLog.push(event.query));
    second.$on("query", (event) => queryLog.push(event.query));
    observer.$on("query", (event) => queryLog.push(event.query));
    await Promise.all([
      primary.$connect(),
      second.$connect(),
      observer.$connect(),
    ]);
    const prefix = `shopify-lifecycle-${randomUUID()}`;
    const storage = new PrismaSessionStorage(primary, {
      connectionRetries: 1,
      connectionRetryIntervalMs: 0,
    });
    const storageSecond = new PrismaSessionStorage(second, {
      connectionRetries: 1,
      connectionRetryIntervalMs: 0,
    });
    await Promise.all([storage.isReady(), storageSecond.isReady()]);
    return {
      prefix,
      primary,
      second,
      observer,
      queryLog,
      storage,
      storageSecond,
      service(client = primary) {
        const coordination = createCoordinatedShopifyAuthentication({
          database: client,
        });
        return new ShopService(client, coordination);
      },
      async createShop(suffix, status = "ACTIVE") {
        const shop = {
          id: `${prefix}-${suffix}`,
          domain: `${prefix}-${suffix}.myshopify.com`,
        };
        await primary.shop.create({ data: { ...shop, status } });
        return shop;
      },
      session(
        shop,
        id,
        token = "offline-token",
        expires = null,
        refreshToken = null,
      ) {
        return new Session({
          id,
          shop,
          state: "lifecycle-test",
          isOnline: false,
          scope: "read_products,read_discounts",
          accessToken: token,
          expires: expires ?? undefined,
          refreshToken: refreshToken ?? undefined,
        });
      },
      async stop() {
        await Promise.allSettled([
          primary.$disconnect(),
          second.$disconnect(),
          observer.$disconnect(),
        ]);
        if (process.env.MODA_SHOPIFY_LIFECYCLE_SQL_EVIDENCE === "1") {
          const statements = [
            ...new Set(
              queryLog.filter((query) =>
                /FOR UPDATE|DELETE FROM .*Session|UPDATE .*Shop|SELECT .*Session|INSERT INTO .*Session/i.test(
                  query,
                ),
              ),
            ),
          ];
          console.info(
            "SHOPIFY_LIFECYCLE_SQL_EVIDENCE",
            JSON.stringify(statements),
          );
        }
        await container?.cleanup();
      },
    };
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.$disconnect()));
    await container.cleanup();
    throw error;
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
