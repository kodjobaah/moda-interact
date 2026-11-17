import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  CredentialSecurityError,
  decryptCredential,
  encryptCredential,
  parseCredentialKeyring,
  resolveActiveCredentialKey,
  type CredentialEnvelope,
  type CredentialKeyring,
} from "@modainteract/moda-interact-shared/security/credentials/node";
import prisma from "../../db.server";
import { logBillingBoundaryFailure } from "../billing/providers/shopify-billing-diagnostics.server";

export const SHOPIFY_CONSENT_RECEIPT_ATTRIBUTE = "moda_wa_consent_v1";
export const SHOPIFY_CONSENT_DISCLOSURE_TEXT =
  "Send me WhatsApp shopping updates, reminders and offers.";
export const SHOPIFY_CONSENT_DISCLOSURE_VERSION = "1";

const KEYRING_ENV = "MODA_ENCRYPTION_KEYS_JSON";
const ACTIVE_KEY_ENV = "MODA_ENCRYPTION_ACTIVE_KEY_ID";
const MAX_RECEIPT_BYTES = 512;
const MAX_BINDING_TOKEN_BYTES = 512;
const FUTURE_CLOCK_SKEW_SECONDS = 5 * 60;
const SHOP_ID_PATTERN = /^[a-z0-9]{20,40}$/;
const CUSTOMER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_KEY_IDS = new Set(["__proto__", "prototype", "constructor"]);

export type ConsentReceiptKind = "c" | "x";
export type ConsentReceiptDecision = "G" | "R";

export type ConsentReceiptClaims = Readonly<{
  shopId: string;
  kind: ConsentReceiptKind;
  bindingDigest: string;
  decision: ConsentReceiptDecision;
  disclosureVersion: "1";
  locale: string;
  acceptedAt: number;
  customerId: string | "-";
}>;

export type ExistingConsentState =
  | "GRANTED"
  | "REVOKED"
  | "UNKNOWN"
  | "NO_CUSTOMER"
  | "NO_CONTACT"
  | "AMBIGUOUS"
  | "UNVERIFIED";

export type ReturningShopperConsentStatus = Readonly<{
  checked: boolean;
  decision: ExistingConsentState;
  source: "postgresql";
}>;

export type ConsentReceiptErrorCode =
  | "INVALID_INPUT"
  | "INVALID_RECEIPT"
  | "RECEIPT_BINDING_MISMATCH"
  | "CREDENTIAL_CONFIGURATION_UNAVAILABLE";

export class ConsentReceiptServiceError extends Error {
  constructor(
    public readonly code: ConsentReceiptErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ConsentReceiptServiceError";
  }
}

function invalidInput(message: string): never {
  throw new ConsentReceiptServiceError("INVALID_INPUT", message);
}

function invalidReceipt(cause?: unknown): never {
  throw new ConsentReceiptServiceError(
    "INVALID_RECEIPT",
    "The Shopify consent receipt is invalid.",
    cause === undefined ? undefined : { cause },
  );
}

function credentialConfigurationFailure(error: unknown): never {
  if (!(error instanceof CredentialSecurityError)) throw error;
  throw new ConsentReceiptServiceError(
    "CREDENTIAL_CONFIGURATION_UNAVAILABLE",
    "Shopify consent receipt encryption is unavailable.",
    { cause: error },
  );
}

function loadCredentialKeyring(): CredentialKeyring {
  try {
    return parseCredentialKeyring(process.env[KEYRING_ENV]);
  } catch (error) {
    return credentialConfigurationFailure(error);
  }
}

function loadIssuingCredentialConfiguration(): {
  keyring: CredentialKeyring;
  activeKeyId: string;
} {
  try {
    const keyring = parseCredentialKeyring(process.env[KEYRING_ENV]);
    const activeKeyId = resolveActiveCredentialKey(keyring, process.env[ACTIVE_KEY_ENV]);
    return { keyring, activeKeyId };
  } catch (error) {
    return credentialConfigurationFailure(error);
  }
}

function validateShopId(shopId: unknown): asserts shopId is string {
  if (typeof shopId !== "string" || !SHOP_ID_PATTERN.test(shopId)) {
    invalidInput("The authenticated shop identity is invalid.");
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalizeLocale(locale: unknown): string {
  if (
    typeof locale !== "string" ||
    locale.length < 2 ||
    locale.length > 35 ||
    !/^[A-Za-z0-9-]+$/.test(locale)
  ) {
    invalidInput("The shopper locale is invalid.");
  }
  try {
    const [canonicalLocale] = Intl.getCanonicalLocales(locale);
    if (!canonicalLocale || canonicalLocale.length > 35) {
      invalidInput("The shopper locale is invalid.");
    }
    return canonicalLocale;
  } catch {
    return invalidInput("The shopper locale is invalid.");
  }
}

function bindingToken(kind: ConsentReceiptKind, token: unknown): string {
  if (typeof token !== "string" || !isWellFormedUnicode(token)) {
    invalidInput("A current Shopify cart or checkout token is required.");
  }
  const normalized = kind === "c" ? token.split("?", 1)[0] : token;
  const byteLength = Buffer.byteLength(normalized, "utf8");
  if (byteLength < 1 || byteLength > MAX_BINDING_TOKEN_BYTES) {
    invalidInput("The current Shopify cart or checkout token is invalid.");
  }
  return normalized;
}

function digestBindingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

function isCanonicalBindingDigest(value: string): boolean {
  if (!SHA256_BASE64URL_PATTERN.test(value)) return false;
  const bytes = Buffer.from(value, "base64url");
  return bytes.byteLength === 32 && bytes.toString("base64url") === value;
}

function consentAad(
  shopId: string,
  kind: ConsentReceiptKind,
  bindingDigest: string,
): string {
  return JSON.stringify(["moda-shopify-wa-consent", 1, shopId, kind, bindingDigest]);
}

function base64urlBytes(value: string): Uint8Array | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== value) return null;
  return Uint8Array.from(bytes);
}

function serializeEnvelope(envelope: CredentialEnvelope): string {
  if (
    !KEY_ID_PATTERN.test(envelope.keyId) ||
    RESERVED_KEY_IDS.has(envelope.keyId) ||
    envelope.nonce.byteLength !== 12 ||
    envelope.ciphertext.byteLength === 0 ||
    envelope.authTag.byteLength !== 16
  ) {
    throw new ConsentReceiptServiceError(
      "INVALID_RECEIPT",
      "The encrypted Shopify consent receipt is invalid.",
    );
  }
  const receipt = [
    "v1",
    envelope.keyId,
    Buffer.from(envelope.nonce).toString("base64url"),
    Buffer.from(envelope.ciphertext).toString("base64url"),
    Buffer.from(envelope.authTag).toString("base64url"),
  ].join(".");
  if (Buffer.byteLength(receipt, "ascii") > MAX_RECEIPT_BYTES) {
    invalidInput("The Shopify consent receipt exceeds its size limit.");
  }
  return receipt;
}

function parseEnvelope(receipt: unknown): CredentialEnvelope {
  if (
    typeof receipt !== "string" ||
    receipt.length > MAX_RECEIPT_BYTES ||
    Buffer.byteLength(receipt, "utf8") !== receipt.length
  ) {
    return invalidReceipt();
  }
  const parts = receipt.split(".");
  if (parts.length !== 5 || parts[0] !== "v1") return invalidReceipt();
  const [, keyId, nonceText, ciphertextText, authTagText] = parts;
  if (!KEY_ID_PATTERN.test(keyId) || RESERVED_KEY_IDS.has(keyId)) return invalidReceipt();
  const nonce = base64urlBytes(nonceText);
  const ciphertext = base64urlBytes(ciphertextText);
  const authTag = base64urlBytes(authTagText);
  if (
    !nonce ||
    nonce.byteLength !== 12 ||
    !ciphertext ||
    ciphertext.byteLength > 8192 ||
    !authTag ||
    authTag.byteLength !== 16
  ) {
    return invalidReceipt();
  }
  return { keyId, nonce, ciphertext, authTag };
}

function isCustomerId(value: unknown): value is string {
  return typeof value === "string" && CUSTOMER_ID_PATTERN.test(value);
}

function validateExpectedCustomerId(customerId: string | null): void {
  if (customerId !== null && !isCustomerId(customerId)) {
    invalidInput("The verified Shopify customer identity is invalid.");
  }
}

function parseClaims(
  plaintext: string,
  nowMs: number,
): ConsentReceiptClaims {
  let value: unknown;
  try {
    value = JSON.parse(plaintext) as unknown;
  } catch (error) {
    return invalidReceipt(error);
  }
  if (!Array.isArray(value) || value.length !== 9 || JSON.stringify(value) !== plaintext) {
    return invalidReceipt();
  }

  const [version, shopId, kind, bindingDigest, decision, disclosureVersion, locale, acceptedAt, customerId] = value;
  if (
    version !== 1 ||
    typeof shopId !== "string" ||
    !SHOP_ID_PATTERN.test(shopId) ||
    (kind !== "c" && kind !== "x") ||
    typeof bindingDigest !== "string" ||
    !isCanonicalBindingDigest(bindingDigest) ||
    (decision !== "G" && decision !== "R") ||
    disclosureVersion !== SHOPIFY_CONSENT_DISCLOSURE_VERSION ||
    typeof locale !== "string" ||
    typeof acceptedAt !== "number" ||
    !Number.isSafeInteger(acceptedAt) ||
    acceptedAt <= 0 ||
    acceptedAt > Math.floor(nowMs / 1000) + FUTURE_CLOCK_SKEW_SECONDS ||
    (customerId !== "-" && !isCustomerId(customerId))
  ) {
    return invalidReceipt();
  }
  try {
    if (canonicalizeLocale(locale) !== locale) return invalidReceipt();
  } catch {
    return invalidReceipt();
  }
  return {
    shopId,
    kind,
    bindingDigest,
    decision,
    disclosureVersion: "1",
    locale,
    acceptedAt,
    customerId,
  };
}

export function issueConsentReceipt(input: {
  shopId: string;
  kind: ConsentReceiptKind;
  token: string;
  decision: ConsentReceiptDecision;
  locale: string;
  customerId: string | null;
}, options: { now?: number } = {}): string {
  validateShopId(input.shopId);
  if (input.kind !== "c" && input.kind !== "x") {
    invalidInput("The Shopify consent receipt kind is invalid.");
  }
  if (input.decision !== "G" && input.decision !== "R") {
    invalidInput("The Shopify consent decision is invalid.");
  }
  validateExpectedCustomerId(input.customerId);
  const nowMs = options.now ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) invalidInput("The server clock is invalid.");

  const token = bindingToken(input.kind, input.token);
  const bindingDigest = digestBindingToken(token);
  const locale = canonicalizeLocale(input.locale);
  const acceptedAt = Math.floor(nowMs / 1000);
  const customerId = input.customerId ?? "-";
  const plaintext = JSON.stringify([
    1,
    input.shopId,
    input.kind,
    bindingDigest,
    input.decision,
    SHOPIFY_CONSENT_DISCLOSURE_VERSION,
    locale,
    acceptedAt,
    customerId,
  ]);
  const aad = consentAad(input.shopId, input.kind, bindingDigest);
  const { keyring, activeKeyId } = loadIssuingCredentialConfiguration();
  try {
    return serializeEnvelope(encryptCredential({
      keyring,
      activeKeyId,
      plaintext,
      aad,
    }));
  } catch (error) {
    if (error instanceof CredentialSecurityError) {
      throw new ConsentReceiptServiceError(
        "CREDENTIAL_CONFIGURATION_UNAVAILABLE",
        "Shopify consent receipt encryption is unavailable.",
        { cause: error },
      );
    }
    throw error;
  }
}

export function verifyConsentReceipt(
  receipt: unknown,
  expected: {
    shopId: string;
    kind: ConsentReceiptKind;
    token: string;
    customerId: string | null;
  },
  options: { now?: number } = {},
): ConsentReceiptClaims {
  validateShopId(expected.shopId);
  if (expected.kind !== "c" && expected.kind !== "x") {
    invalidInput("The expected Shopify receipt kind is invalid.");
  }
  validateExpectedCustomerId(expected.customerId);
  const nowMs = options.now ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) invalidInput("The server clock is invalid.");
  const token = bindingToken(expected.kind, expected.token);
  const bindingDigest = digestBindingToken(token);
  const envelope = parseEnvelope(receipt);
  const keyring = loadCredentialKeyring();
  if (!keyring.hasKey(envelope.keyId)) return invalidReceipt();

  let plaintext: string;
  try {
    plaintext = decryptCredential({
      keyring,
      envelope,
      aad: consentAad(expected.shopId, expected.kind, bindingDigest),
    });
  } catch (error) {
    if (error instanceof CredentialSecurityError) return invalidReceipt(error);
    throw error;
  }
  const claims = parseClaims(plaintext, nowMs);
  if (
    claims.shopId !== expected.shopId ||
    claims.kind !== expected.kind ||
    claims.bindingDigest !== bindingDigest ||
    claims.customerId !== (expected.customerId ?? "-")
  ) {
    throw new ConsentReceiptServiceError(
      "RECEIPT_BINDING_MISMATCH",
      "The Shopify consent receipt does not match this shop, customer and checkout.",
    );
  }
  return claims;
}

export function verifyConsentReceiptAttributes(
  attributes: unknown,
  expected: {
    shopId: string;
    kind: ConsentReceiptKind;
    token: string;
    customerId: string | null;
  },
  options: { now?: number } = {},
): ConsentReceiptClaims | null {
  if (!Array.isArray(attributes)) return invalidReceipt();
  let receipt: unknown;
  let found = false;
  for (const attribute of attributes) {
    if (!attribute || typeof attribute !== "object" || Array.isArray(attribute)) continue;
    if (
      !Object.hasOwn(attribute, "key") ||
      !("key" in attribute) ||
      attribute.key !== SHOPIFY_CONSENT_RECEIPT_ATTRIBUTE
    ) continue;
    if (
      found ||
      !Object.hasOwn(attribute, "value") ||
      !("value" in attribute) ||
      typeof attribute.value !== "string"
    ) return invalidReceipt();
    found = true;
    receipt = attribute.value;
  }
  return found ? verifyConsentReceipt(receipt, expected, options) : null;
}

async function readExistingCustomerConsent(
  shopId: string,
  shopifyCustomerId: string,
  database: Pick<PrismaClient, "customer">,
): Promise<ExistingConsentState> {
  const customer = await database.customer.findUnique({
    where: {
      shopId_shopifyCustomerId: { shopId, shopifyCustomerId },
    },
    select: {
      phones: {
        where: { endedAt: null },
        select: {
          whatsappCanonicalPhone: true,
          whatsappPhoneVerifiedAt: true,
          whatsappConsentPurpose: true,
          whatsappConsentDecision: true,
          whatsappConsentSource: true,
          whatsappConsentProviderObservedAt: true,
          whatsappConsentVerifiedAt: true,
          whatsappNoContact: true,
          whatsappNoContactReason: true,
          whatsappNoContactClearedAt: true,
        },
      },
    },
  });
  if (!customer) return "NO_CUSTOMER";
  if (customer.phones.length > 1) return "AMBIGUOUS";
  const phone = customer.phones[0];
  if (!phone) return "UNKNOWN";

  const unclearedNoContact = phone.whatsappNoContactReason !== null &&
    phone.whatsappNoContactClearedAt === null;
  if (phone.whatsappNoContact || unclearedNoContact) return "NO_CONTACT";

  const currentModaConsent =
    phone.whatsappConsentSource === "SHOPIFY_NATIVE" &&
    phone.whatsappConsentProviderObservedAt === null &&
    phone.whatsappConsentPurpose === "WHATSAPP_CHECKOUT_RECOVERY" &&
    phone.whatsappCanonicalPhone !== null &&
    phone.whatsappPhoneVerifiedAt !== null &&
    phone.whatsappConsentVerifiedAt !== null;
  if (!currentModaConsent) return "UNVERIFIED";
  if (phone.whatsappConsentDecision === "GRANTED") return "GRANTED";
  if (phone.whatsappConsentDecision === "REVOKED") return "REVOKED";
  if (phone.whatsappConsentDecision === "UNKNOWN") return "UNKNOWN";
  return "UNVERIFIED";
}

export async function readReturningShopperConsentStatus(input: {
  shopId: string;
  shopifyCustomerId: string | null;
  database?: Pick<PrismaClient, "customer">;
}): Promise<ReturningShopperConsentStatus> {
  validateShopId(input.shopId);
  if (input.shopifyCustomerId !== null && !isCustomerId(input.shopifyCustomerId)) {
    invalidInput("The verified Shopify customer identity is invalid.");
  }
  const decision = input.shopifyCustomerId
    ? await readExistingCustomerConsent(input.shopId, input.shopifyCustomerId, input.database ?? prisma)
    : "NO_CUSTOMER";
  return { checked: decision === "GRANTED", decision, source: "postgresql" };
}

export function logShopifyConsentFailure(input: {
  operation: "app_proxy_authentication" | "shop_resolution" | "status_read" | "cart_receipt" | "checkout_receipt";
  stage: string;
  error: unknown;
  shopId?: string;
  sensitiveValues?: string[];
  reasonCode?: string;
}): void {
  const consentError = input.error instanceof ConsentReceiptServiceError ? input.error : null;
  logBillingBoundaryFailure({
    event: "shopify.consent.request.failed",
    operation: input.operation,
    stage: input.stage,
    ...(input.shopId ? { shopId: input.shopId } : {}),
    ...(input.reasonCode || consentError ? { reasonCode: input.reasonCode ?? consentError?.code } : {}),
    error: input.error,
    sensitiveValues: input.sensitiveValues,
  });
}
