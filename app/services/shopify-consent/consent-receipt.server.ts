import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { logBillingBoundaryFailure } from "../billing/providers/shopify-billing-diagnostics.server";

export const SHOPIFY_CONSENT_RECEIPT_ATTRIBUTE = "moda_wa_consent_v1";
export const SHOPIFY_CONSENT_RECEIPT_KEY_ENV = "SHOPIFY_CONSENT_RECEIPT_KEY_V1";
export const SHOPIFY_CONSENT_DISCLOSURE_TEXT =
  "Send me WhatsApp shopping updates, reminders and offers.";
export const SHOPIFY_CONSENT_DISCLOSURE_VERSION = "1";

const MAX_RECEIPT_BYTES = 512;
const MAX_BINDING_TOKEN_BYTES = 512;
const FUTURE_CLOCK_SKEW_SECONDS = 5 * 60;
const SHOP_ID_PATTERN = /^[a-z0-9]{20,40}$/;
const CUSTOMER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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
  | "SIGNING_KEY_UNAVAILABLE";

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

let signingKey: Buffer | undefined;

function decodeSigningKey(value: string | undefined): Buffer {
  if (!value || !BASE64URL_32_PATTERN.test(value)) {
    throw new ConsentReceiptServiceError(
      "SIGNING_KEY_UNAVAILABLE",
      `${SHOPIFY_CONSENT_RECEIPT_KEY_ENV} must be 32 random bytes encoded as unpadded base64url.`,
    );
  }
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) {
    throw new ConsentReceiptServiceError(
      "SIGNING_KEY_UNAVAILABLE",
      `${SHOPIFY_CONSENT_RECEIPT_KEY_ENV} is not canonical 32-byte base64url.`,
    );
  }
  return key;
}

export function initializeConsentReceiptSigningKey(): void {
  signingKey = undefined;
  signingKey = decodeSigningKey(process.env[SHOPIFY_CONSENT_RECEIPT_KEY_ENV]);
}

function getSigningKey(): Buffer {
  if (!signingKey) {
    throw new ConsentReceiptServiceError(
      "SIGNING_KEY_UNAVAILABLE",
      "The Shopify consent receipt signing key is not configured.",
    );
  }
  return signingKey;
}

function invalidInput(message: string): never {
  throw new ConsentReceiptServiceError("INVALID_INPUT", message);
}

function validateShopId(shopId: unknown): asserts shopId is string {
  if (typeof shopId !== "string" || !SHOP_ID_PATTERN.test(shopId)) {
    invalidInput("The authenticated shop identity is invalid.");
  }
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
  if (typeof token !== "string") {
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

function encodeBase64url32(value: string): Buffer | null {
  if (!BASE64URL_32_PATTERN.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value ? bytes : null;
}

function parseReceipt(receipt: unknown, nowMs: number): ConsentReceiptClaims & { prefix: string; mac: Buffer } {
  if (
    typeof receipt !== "string" ||
    receipt.length > MAX_RECEIPT_BYTES ||
    Buffer.byteLength(receipt, "utf8") !== receipt.length ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0
  ) {
    throw new ConsentReceiptServiceError("INVALID_RECEIPT", "The Shopify consent receipt is invalid.");
  }

  const parts = receipt.split(".");
  if (parts.length !== 10 || parts.some(part => part.length === 0)) {
    throw new ConsentReceiptServiceError("INVALID_RECEIPT", "The Shopify consent receipt is invalid.");
  }

  const [version, shopId, kind, bindingDigest, decision, disclosureVersion, locale, acceptedAtText, customerId, macText] = parts;
  const mac = encodeBase64url32(macText);
  const digest = encodeBase64url32(bindingDigest);
  const acceptedAt = /^[1-9][0-9]{0,15}$/.test(acceptedAtText) ? Number(acceptedAtText) : NaN;
  let canonicalLocale: string | undefined;
  try {
    canonicalLocale = canonicalizeLocale(locale);
  } catch {
    canonicalLocale = undefined;
  }

  if (
    version !== "v1" ||
    !SHOP_ID_PATTERN.test(shopId) ||
    (kind !== "c" && kind !== "x") ||
    !digest ||
    (decision !== "G" && decision !== "R") ||
    disclosureVersion !== SHOPIFY_CONSENT_DISCLOSURE_VERSION ||
    canonicalLocale !== locale ||
    !Number.isSafeInteger(acceptedAt) ||
    acceptedAt <= 0 ||
    acceptedAt > Math.floor(nowMs / 1000) + FUTURE_CLOCK_SKEW_SECONDS ||
    (customerId !== "-" && !CUSTOMER_ID_PATTERN.test(customerId)) ||
    !mac
  ) {
    throw new ConsentReceiptServiceError("INVALID_RECEIPT", "The Shopify consent receipt is invalid.");
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
    prefix: parts.slice(0, 9).join("."),
    mac,
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
  if (input.kind !== "c" && input.kind !== "x") invalidInput("The Shopify consent receipt kind is invalid.");
  if (input.decision !== "G" && input.decision !== "R") invalidInput("The Shopify consent decision is invalid.");
  if (input.customerId !== null && !CUSTOMER_ID_PATTERN.test(input.customerId)) {
    invalidInput("The verified Shopify customer identity is invalid.");
  }
  const nowMs = options.now ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) invalidInput("The server clock is invalid.");
  const token = bindingToken(input.kind, input.token);
  const locale = canonicalizeLocale(input.locale);
  const acceptedAt = Math.floor(nowMs / 1000);
  const prefix = [
    "v1",
    input.shopId,
    input.kind,
    digestBindingToken(token),
    input.decision,
    SHOPIFY_CONSENT_DISCLOSURE_VERSION,
    locale,
    String(acceptedAt),
    input.customerId ?? "-",
  ].join(".");
  const mac = createHmac("sha256", getSigningKey()).update(prefix, "utf8").digest("base64url");
  const receipt = `${prefix}.${mac}`;
  if (Buffer.byteLength(receipt, "ascii") > MAX_RECEIPT_BYTES) {
    throw new ConsentReceiptServiceError("INVALID_INPUT", "The Shopify consent receipt exceeds its size limit.");
  }
  return receipt;
}

export function verifyConsentReceipt(
  receipt: unknown,
  expected: { shopId: string; kind: ConsentReceiptKind; token: string },
  options: { now?: number } = {},
): ConsentReceiptClaims {
  validateShopId(expected.shopId);
  if (expected.kind !== "c" && expected.kind !== "x") invalidInput("The expected Shopify receipt kind is invalid.");
  const expectedToken = bindingToken(expected.kind, expected.token);
  const claims = parseReceipt(receipt, options.now ?? Date.now());
  const expectedMac = createHmac("sha256", getSigningKey()).update(claims.prefix, "utf8").digest();
  if (!timingSafeEqual(expectedMac, claims.mac)) {
    throw new ConsentReceiptServiceError("INVALID_RECEIPT", "The Shopify consent receipt is invalid.");
  }
  if (
    claims.shopId !== expected.shopId ||
    claims.kind !== expected.kind ||
    claims.bindingDigest !== digestBindingToken(expectedToken)
  ) {
    throw new ConsentReceiptServiceError(
      "RECEIPT_BINDING_MISMATCH",
      "The Shopify consent receipt does not match this shop and checkout.",
    );
  }
  return {
    shopId: claims.shopId,
    kind: claims.kind,
    bindingDigest: claims.bindingDigest,
    decision: claims.decision,
    disclosureVersion: claims.disclosureVersion,
    locale: claims.locale,
    acceptedAt: claims.acceptedAt,
    customerId: claims.customerId,
  };
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
          whatsappConsentVerifiedAt: true,
          whatsappNoContact: true,
        },
      },
    },
  });
  if (!customer) return "NO_CUSTOMER";
  if (customer.phones.length > 1) return "AMBIGUOUS";
  const phone = customer.phones[0];
  if (!phone) return "UNKNOWN";
  if (phone.whatsappNoContact) return "NO_CONTACT";
  if (
    phone.whatsappCanonicalPhone &&
    phone.whatsappPhoneVerifiedAt &&
    phone.whatsappConsentVerifiedAt &&
    phone.whatsappConsentPurpose === "WHATSAPP_CHECKOUT_RECOVERY" &&
    phone.whatsappConsentDecision === "GRANTED"
  ) {
    return "GRANTED";
  }
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
  if (input.shopifyCustomerId !== null && !CUSTOMER_ID_PATTERN.test(input.shopifyCustomerId)) {
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
