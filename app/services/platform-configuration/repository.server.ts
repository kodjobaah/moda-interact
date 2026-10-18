import { configurationFailure, type ShopifyConfigurationKey } from "./contracts.server";

export type PlatformConfigurationRow = Readonly<{
  environment: string;
  key: string;
  version: number;
  value: unknown;
}>;

/** Minimal Prisma read-only port; no audit writer and no browser-owned selectors. */
export interface PlatformConfigurationDatabase {
  platformConfiguration: {
    findUnique(args: {
      where: { environment_key: { environment: string; key: string } };
      select: { environment: true; key: true; version: true; value: true };
    }): Promise<PlatformConfigurationRow | null>;
  };
}

const ENVIRONMENTS = new Set(["local", "test", "development", "staging", "production"]);

export function assertDeploymentEnvironment(environment: string, key: ShopifyConfigurationKey): void {
  if (!ENVIRONMENTS.has(environment)) configurationFailure(key, "INVALID_ENVIRONMENT");
}

export async function readPlatformConfiguration(
  database: PlatformConfigurationDatabase,
  environment: string,
  key: ShopifyConfigurationKey,
): Promise<PlatformConfigurationRow> {
  assertDeploymentEnvironment(environment, key);
  let row: PlatformConfigurationRow | null;
  try {
    row = await database.platformConfiguration.findUnique({
      where: { environment_key: { environment, key } },
      select: { environment: true, key: true, version: true, value: true },
    });
  } catch {
    return configurationFailure(key, "DATABASE_UNAVAILABLE");
  }
  if (!row) configurationFailure(key, "MISSING");
  if (row.key !== key || row.environment !== environment ||
      !Number.isSafeInteger(row.version) || row.version < 1 || row.version > 2_147_483_647) {
    configurationFailure(key, "INVALID_ROW");
  }
  return row;
}
