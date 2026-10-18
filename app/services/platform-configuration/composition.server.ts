import {
  parseCredentialKeyring,
  resolveActiveCredentialKey,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../db.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";
import { createShopifyPlatformConfigurationService } from "./service.server";

/**
 * Server-only composition for SHOPIFY-002. The Shopify app's synchronous
 * shopifyApp construction and every current runtime consumer are unchanged.
 */
export function createDefaultShopifyPlatformConfigurationService() {
  const environment = resolveDeploymentEnvironmentName();
  return createShopifyPlatformConfigurationService({
    database: prisma,
    environment,
    loadUnsealKeyring: () => {
      const keyring = parseCredentialKeyring(process.env.MODA_CONFIG_UNSEAL_KEY);
      resolveActiveCredentialKey(keyring, process.env.MODA_CONFIG_UNSEAL_ACTIVE_KEY_ID);
      return keyring;
    },
    logger: createLogger({ serviceName: "moda-interact", environment }),
  });
}
