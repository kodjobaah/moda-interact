import type { CredentialKeyring } from "@modainteract/moda-interact-shared/security/credentials/node";
import {
  ShopifyPlatformConfigurationError, configurationFailure,
  type ShopifyConfigurationKey, type ShopifyConfigurationErrorCode,
  type ShopifyPlatformConfigurationService,
} from "./contracts.server";
import { readPlatformConfiguration, type PlatformConfigurationDatabase } from "./repository.server";
import { isDisabledConfiguration, unsealPlatformConfiguration } from "./seal.server";
import { decodeMerchantKnowledgeR2Configuration } from "./merchant-knowledge-r2.server";
import { decodeShopifyOAuthCredentials } from "./shopify-oauth-credentials.server";
import { decodeShopifyPartnerCredentials } from "./shopify-partner-credentials.server";

export type ConfigurationLogger = {
  info(event: string, data: Record<string, unknown>): void;
  warn(event: string, data: Record<string, unknown>): void;
};

export interface ShopifyConfigurationServiceDependencies {
  database: PlatformConfigurationDatabase;
  environment: string;
  /** Called lazily per operation; unseal material must never come from PostgreSQL. */
  loadUnsealKeyring(): CredentialKeyring;
  logger?: ConfigurationLogger;
}

/** Exactly one row lookup and one unseal per request; never retain a credential snapshot. */
export function createShopifyPlatformConfigurationService(
  dependencies: ShopifyConfigurationServiceDependencies,
): ShopifyPlatformConfigurationService {
  function safeLog(level: "info" | "warn", data: Record<string, unknown>): void {
    try { dependencies.logger?.[level]("shopify.platform_configuration.read", data); }
    catch { /* Shared logging must not become a correctness dependency. */ }
  }

  async function read<T>(key: ShopifyConfigurationKey, operation: string, decode: (version: number, value: unknown) => T): Promise<T> {
    try {
      const row = await readPlatformConfiguration(dependencies.database, dependencies.environment, key);
      if (isDisabledConfiguration(row.value)) configurationFailure(key, "DISABLED");
      let keyring: CredentialKeyring;
      try { keyring = dependencies.loadUnsealKeyring(); }
      catch { return configurationFailure(key, "UNSEAL_FAILED"); }
      const payload = unsealPlatformConfiguration({
        environment: dependencies.environment,
        key,
        version: row.version,
        value: row.value,
        keyring,
      });
      const result = decode(row.version, payload);
      safeLog("info", { key, operation, version: row.version, outcome: "success" });
      return result;
    } catch (error) {
      const reasonCode: ShopifyConfigurationErrorCode | "UNEXPECTED" = error instanceof ShopifyPlatformConfigurationError
        ? error.code : "UNEXPECTED";
      safeLog("warn", { key, operation, outcome: "failed", reasonCode });
      if (error instanceof ShopifyPlatformConfigurationError) throw error;
      return configurationFailure(key, "INVALID_VALUE");
    }
  }

  return Object.freeze({
    requireMerchantKnowledgeR2Configuration: () => read(
      "merchant.knowledge.r2", "require_r2", decodeMerchantKnowledgeR2Configuration),
    requireShopifyOAuthCredentials: () => read(
      "shopify.oauth", "require_oauth", decodeShopifyOAuthCredentials),
    requireShopifyPartnerCredentials: () => read(
      "shopify.partner", "require_partner", decodeShopifyPartnerCredentials),
  });
}
