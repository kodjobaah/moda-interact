import { Buffer } from "node:buffer";
import {
  decryptCredential,
  type CredentialEnvelope,
  type CredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import { configurationFailure, type ShopifyConfigurationKey } from "./contracts.server";
import { assertDeploymentEnvironment } from "./repository.server";

const ENVELOPE_KEYS = ["kind", "schemaVersion", "algorithm", "wrappingKeyId", "nonce", "ciphertext", "authTag"];
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function closedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const found = Object.keys(value);
  return found.length === keys.length && found.every((key) => keys.includes(key));
}

export function isDisabledConfiguration(value: unknown): boolean {
  return closedRecord(value, ["kind", "schemaVersion"]) &&
    value.kind === "disabled" && value.schemaVersion === 1;
}

function canonicalBase64(value: unknown, length: number | null): Uint8Array | null {
  if (typeof value !== "string" || !value || !BASE64.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > 8192 || bytes.toString("base64") !== value ||
      (length !== null && bytes.length !== length)) return null;
  return Uint8Array.from(bytes);
}

export function parseSealedEnvelope(key: ShopifyConfigurationKey, value: unknown): CredentialEnvelope {
  if (!closedRecord(value, ENVELOPE_KEYS) || value.kind !== "sealed" || value.schemaVersion !== 1 ||
      value.algorithm !== "AES-256-GCM" || typeof value.wrappingKeyId !== "string" ||
      !KEY_ID.test(value.wrappingKeyId) || RESERVED.has(value.wrappingKeyId)) {
    configurationFailure(key, "INVALID_ENVELOPE");
  }
  const nonce = canonicalBase64(value.nonce, 12);
  const ciphertext = canonicalBase64(value.ciphertext, null);
  const authTag = canonicalBase64(value.authTag, 16);
  if (!nonce || !ciphertext || !authTag) configurationFailure(key, "INVALID_ENVELOPE");
  return { keyId: value.wrappingKeyId as string, nonce, ciphertext, authTag };
}

/** Byte-for-byte ADMIN-002 AAD, not Shopify provider or grant AAD. */
export function platformConfigurationAAD(
  environment: string, key: ShopifyConfigurationKey, version: number,
): string {
  assertDeploymentEnvironment(environment, key);
  if (!Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) {
    configurationFailure(key, "INVALID_ROW");
  }
  return JSON.stringify(["moda-platform-config-v1", environment, key, version, 1]);
}

export function unsealPlatformConfiguration(input: {
  environment: string;
  key: ShopifyConfigurationKey;
  version: number;
  value: unknown;
  keyring: CredentialKeyring;
}): unknown {
  if (isDisabledConfiguration(input.value)) configurationFailure(input.key, "DISABLED");
  const envelope = parseSealedEnvelope(input.key, input.value);
  let plaintext: string;
  try {
    plaintext = decryptCredential({
      keyring: input.keyring,
      envelope,
      aad: platformConfigurationAAD(input.environment, input.key, input.version),
    });
  } catch {
    // Never expose decryption-provider diagnostics through configuration errors.
    return configurationFailure(input.key, "UNSEAL_FAILED");
  }
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    return configurationFailure(input.key, "INVALID_VALUE");
  }
}
