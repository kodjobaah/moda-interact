import type { Prisma } from "@prisma/client";
import { parseCredentialKeyring, resolveActiveCredentialKey } from "@modainteract/moda-interact-shared/security/credentials/node";
import { ShopifyPlatformConfigurationError } from "../platform-configuration/contracts.server";
import { readPlatformConfiguration } from "../platform-configuration/repository.server";
import { unsealPlatformConfiguration } from "../platform-configuration/seal.server";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";

const WABA = /^\d{4,32}$/;

/** The authenticated Shopify shop is NOT authority for the Meta sender.
 * Reuse the ARCH-043 sealed configuration reader and its AAD/keyring contract.
 * Environment fallback is permitted only when the sealed record is absent.
 */
export async function trustedRecoverySenderWaba(db: Pick<Prisma.TransactionClient, "platformConfiguration">): Promise<string> {
  const environment = resolveDeploymentEnvironmentName();
  const key = "messaging.sender" as const;
  let record;
  try {
    record = await readPlatformConfiguration(db, environment, key);
  } catch (error) {
    if (!(error instanceof ShopifyPlatformConfigurationError) || error.code !== "MISSING") throw error;
    const configured = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    if (!configured || !WABA.test(configured)) throw new Error("recovery_sender_unavailable");
    return configured;
  }
  // A present but invalid/disabled row must never fall back to an older env value.
  const keyring = parseCredentialKeyring(process.env.MODA_CONFIG_UNSEAL_KEY);
  resolveActiveCredentialKey(keyring, process.env.MODA_CONFIG_UNSEAL_ACTIVE_KEY_ID);
  const value = unsealPlatformConfiguration({
    environment, key, version: record.version, value: record.value, keyring,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery_sender_unavailable");
  const wabaId = (value as Record<string, unknown>).businessAccountId;
  if (typeof wabaId !== "string" || !WABA.test(wabaId)) throw new Error("recovery_sender_unavailable");
  return wabaId;
}
