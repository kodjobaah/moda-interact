import {
  parseCredentialKeyring,
  resolveActiveCredentialKey,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../db.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";
import { createShopifyPlatformConfigurationService } from "./service.server";

/**
 * Server-only composition of operation-scoped sealed configuration reads,
 * deployment environment and the unseal keyring for Shopify runtime consumers.
 */
export function createDefaultShopifyPlatformConfigurationService() {
  const environment = resolveDeploymentEnvironmentName();
  return createShopifyPlatformConfigurationService({
    database: prisma,
    environment,
    loadUnsealKeyring: () => {
      const keyring = parseCredentialKeyring(process.env.MODA_ENCRYPTION_KEYS_JSON);
      resolveActiveCredentialKey(keyring, process.env.MODA_ENCRYPTION_ACTIVE_KEY_ID);
      return keyring;
    },
    logger: createLogger({ serviceName: "moda-interact", environment }),
  });
}
