import { createHash, randomBytes } from "node:crypto";
import Redis from "ioredis";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import prisma from "../../db.server";
import { logBillingBoundaryFailure } from "../billing/providers/shopify-billing-diagnostics.server";
import { isShopifyConsentMarker } from "./marker";

export const SHOPIFY_CONSENT_DISCLOSURE_TEXT =
  "Send me WhatsApp shopping updates, reminders and offers.";
export const SHOPIFY_CONSENT_DISCLOSURE_VERSION = "shopify-consent-v1";
export const SHOPIFY_CONSENT_CART_TTL_MS = 48 * 60 * 60 * 1000;

const MAX_ACTIONS_PER_CART = 128;
const REDIS_TIMEOUT_MS = 2_500;
const CART_PREFIX = "shopify:consent:v1:cart:";
const MARKER_PREFIX = "shopify:consent:v1:marker:";

const DecisionSchema = z.enum(["GRANT", "REVOKE"]);
const ChoiceSchema = z.object({
  actionId: z.string().min(1).max(128),
  decision: DecisionSchema,
  disclosureText: z.literal(SHOPIFY_CONSENT_DISCLOSURE_TEXT),
  disclosureVersion: z.literal(SHOPIFY_CONSENT_DISCLOSURE_VERSION),
  locale: z.string().min(2).max(64),
  acceptedAtMs: z.number().int().positive(),
  revision: z.number().int().positive(),
  shopifyCustomerIdAtAction: z.string().regex(/^[1-9]\d{0,19}$/).nullable(),
}).strict();
const CartRecordSchema = z.object({
  v: z.literal(1),
  shopId: z.string().min(1),
  cartDigest: z.string().regex(/^[a-f0-9]{64}$/),
  marker: z.string().refine(isShopifyConsentMarker),
  issuedAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
  latestExplicitChoice: ChoiceSchema.optional(),
  choiceRevision: z.number().int().nonnegative(),
  actionHistory: z.record(z.string(), z.object({
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().positive(),
  }).strict()),
}).strict();
const MarkerRecordSchema = z.object({
  v: z.literal(1),
  shopId: z.string().min(1),
  cartDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAtMs: z.number().int().positive(),
  expiresAtMs: z.number().int().positive(),
  checkoutDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

type CartRecord = z.infer<typeof CartRecordSchema>;

export type ShopifyConsentErrorCode =
  | "INVALID_CART_TOKEN"
  | "INVALID_MARKER"
  | "INVALID_CHOICE"
  | "REDIS_UNAVAILABLE"
  | "MARKER_COLLISION"
  | "RECORD_CONFLICT"
  | "RECORD_CORRUPT"
  | "STALE_REVISION"
  | "ACTION_ID_CONFLICT"
  | "ACTION_HISTORY_LIMIT";

export class ShopifyConsentServiceError extends Error {
  constructor(
    public readonly code: ShopifyConsentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ShopifyConsentServiceError";
  }
}

type RedisOperation<T> = (client: Redis) => Promise<T>;

const PREPARE_CART_SCRIPT = `
local function decode(raw)
  if not raw then return nil end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= "table" then return nil end
  return value
end
local cartRaw = redis.call("GET", KEYS[1])
if cartRaw then
  local cart = decode(cartRaw)
  if not cart or cart.v ~= 1 or cart.shopId ~= ARGV[5] or cart.cartDigest ~= ARGV[6] or
    type(cart.marker) ~= "string" or string.len(cart.marker) ~= 46 or
    not string.match(cart.marker, "^m1_[A-Za-z0-9_-]+$") then
    return {"CORRUPT"}
  end
  local markerKey = ARGV[4] .. cart.marker
  local markerRaw = redis.call("GET", markerKey)
  local marker = decode(markerRaw)
  if not marker or marker.v ~= 1 or marker.shopId ~= ARGV[5] or
    marker.cartDigest ~= ARGV[6] or marker.expiresAtMs <= tonumber(ARGV[7]) or
    cart.expiresAtMs <= tonumber(ARGV[7]) or
    redis.call("PTTL", KEYS[1]) <= 0 or redis.call("PTTL", markerKey) <= 0 then
    return {"INCONSISTENT"}
  end
  return {"EXISTING", cartRaw}
end
if redis.call("EXISTS", KEYS[2]) == 1 then
  return {"COLLISION"}
end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[3])
redis.call("SET", KEYS[2], ARGV[2], "PX", ARGV[3])
return {"CREATED", ARGV[1]}
`;

const READ_CART_SCRIPT = `
local function decode(raw)
  if not raw then return nil end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= "table" then return nil end
  return value
end
local cartRaw = redis.call("GET", KEYS[1])
if not cartRaw then return {"NO_CART"} end
local cart = decode(cartRaw)
if not cart or cart.v ~= 1 or cart.shopId ~= ARGV[1] or
  type(cart.cartDigest) ~= "string" or type(cart.marker) ~= "string" or
  string.len(cart.marker) ~= 46 or not string.match(cart.marker, "^m1_[A-Za-z0-9_-]+$") then
  return {"CORRUPT"}
end
local markerKey = ARGV[2] .. cart.marker
local markerRaw = redis.call("GET", markerKey)
local marker = decode(markerRaw)
if not marker or marker.v ~= 1 or marker.shopId ~= ARGV[1] or
  marker.cartDigest ~= cart.cartDigest or marker.expiresAtMs <= tonumber(ARGV[3]) or
  cart.expiresAtMs <= tonumber(ARGV[3]) or
  redis.call("PTTL", KEYS[1]) <= 0 or redis.call("PTTL", markerKey) <= 0 then
  return {"INCONSISTENT"}
end
return {"CART", cartRaw}
`;

const RECORD_CHOICE_SCRIPT = `
local function decode(raw)
  if not raw then return nil end
  local ok, value = pcall(cjson.decode, raw)
  if not ok or type(value) ~= "table" then return nil end
  return value
end
local cartRaw = redis.call("GET", KEYS[1])
local markerRaw = redis.call("GET", KEYS[2])
local cart = decode(cartRaw)
local markerRecord = decode(markerRaw)
if not cart or not markerRecord or cart.v ~= 1 or markerRecord.v ~= 1 or
  cart.shopId ~= ARGV[1] or markerRecord.shopId ~= ARGV[1] or
  cart.cartDigest ~= ARGV[2] or markerRecord.cartDigest ~= ARGV[2] or
  cart.marker ~= ARGV[3] or type(cart.actionHistory) ~= "table" or
  cart.expiresAtMs <= tonumber(ARGV[8]) or markerRecord.expiresAtMs <= tonumber(ARGV[8]) or
  redis.call("PTTL", KEYS[1]) <= 0 or redis.call("PTTL", KEYS[2]) <= 0 then
  return {"INCONSISTENT"}
end
local existing = cart.actionHistory[ARGV[4]]
if existing then
  if existing.payloadHash ~= ARGV[5] then return {"ACTION_ID_CONFLICT"} end
  return {"REPLAY", tostring(cart.choiceRevision), cartRaw}
end
if tonumber(cart.choiceRevision) ~= tonumber(ARGV[6]) then
  return {"STALE_REVISION", tostring(cart.choiceRevision)}
end
local actionCount = 0
for _ in pairs(cart.actionHistory) do actionCount = actionCount + 1 end
if actionCount >= tonumber(ARGV[9]) then return {"ACTION_HISTORY_LIMIT"} end
local choice = decode(ARGV[7])
if not choice then return {"CORRUPT"} end
local newRevision = tonumber(cart.choiceRevision) + 1
choice.revision = newRevision
cart.choiceRevision = newRevision
cart.latestExplicitChoice = choice
cart.actionHistory[ARGV[4]] = {payloadHash = ARGV[5], revision = newRevision}
local updated = cjson.encode(cart)
redis.call("SET", KEYS[1], updated, "KEEPTTL")
return {"UPDATED", tostring(newRevision), updated}
`;

function assertShopId(shopId: string): void {
  if (!/^[A-Za-z0-9_-]{1,191}$/.test(shopId)) {
    throw new ShopifyConsentServiceError("RECORD_CONFLICT", "The authenticated shop identity is invalid.");
  }
}

export function canonicalShopifyCartToken(cartToken: string): string {
  if (typeof cartToken !== "string") {
    throw new ShopifyConsentServiceError("INVALID_CART_TOKEN", "A current cart token is required.");
  }
  const cartBaseToken = cartToken.split("?")[0];
  const bytes = Buffer.byteLength(cartBaseToken, "utf8");
  if (bytes < 1 || bytes > 512) {
    throw new ShopifyConsentServiceError("INVALID_CART_TOKEN", "The current cart token is invalid.");
  }
  return cartBaseToken;
}

export function shopifyConsentDigest(
  kind: "cart" | "checkout",
  shopId: string,
  value: string,
): string {
  assertShopId(shopId);
  if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 512) {
    throw new ShopifyConsentServiceError(
      kind === "cart" ? "INVALID_CART_TOKEN" : "RECORD_CONFLICT",
      `The Shopify ${kind} identity is invalid.`,
    );
  }
  return createHash("sha256")
    .update(`arch077:v1\0${kind}\0${shopId}\0${value}`, "utf8")
    .digest("hex");
}

function cartKey(shopId: string, cartDigest: string): string {
  return `${CART_PREFIX}${shopId}:${cartDigest}`;
}

function markerKey(shopId: string, marker: string): string {
  return `${MARKER_PREFIX}${shopId}:${marker}`;
}

async function withRedis<T>(operation: RedisOperation<T>): Promise<T> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new ShopifyConsentServiceError(
      "REDIS_UNAVAILABLE",
      "Temporary Shopify consent storage is unavailable.",
      { cause: new Error("REDIS_URL is not configured.") },
    );
  }

  let client: Redis | undefined;
  try {
    client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: REDIS_TIMEOUT_MS,
      commandTimeout: REDIS_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    await withTimeout(client.connect());
    return await withTimeout(operation(client));
  } catch (error) {
    if (error instanceof ShopifyConsentServiceError) throw error;
    throw new ShopifyConsentServiceError(
      "REDIS_UNAVAILABLE",
      "Temporary Shopify consent storage is unavailable.",
      { cause: error },
    );
  } finally {
    client?.disconnect();
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Shopify consent Redis operation timed out.")),
        REDIS_TIMEOUT_MS,
      );
    }),
  ]);
}

function parseCartRecord(raw: string): CartRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ShopifyConsentServiceError(
      "RECORD_CORRUPT",
      "The temporary Shopify cart record is invalid.",
      { cause: error },
    );
  }
  const parsed = CartRecordSchema.safeParse(value);
  if (!parsed.success || Object.keys(parsed.data.actionHistory).length > MAX_ACTIONS_PER_CART) {
    throw new ShopifyConsentServiceError(
      "RECORD_CORRUPT",
      "The temporary Shopify cart record is invalid.",
    );
  }
  return parsed.data;
}

function mapScriptCode(code: string | undefined): never {
  switch (code) {
    case "COLLISION":
      throw new ShopifyConsentServiceError("MARKER_COLLISION", "A Shopify cart marker collision was detected.");
    case "INCONSISTENT":
      throw new ShopifyConsentServiceError("RECORD_CONFLICT", "The temporary Shopify cart records are inconsistent.");
    case "CORRUPT":
      throw new ShopifyConsentServiceError("RECORD_CORRUPT", "The temporary Shopify cart record is invalid.");
    case "ACTION_ID_CONFLICT":
      throw new ShopifyConsentServiceError("ACTION_ID_CONFLICT", "The action ID was reused with a different payload.");
    case "STALE_REVISION":
      throw new ShopifyConsentServiceError("STALE_REVISION", "The cart choice has changed; reload its current status.");
    case "ACTION_HISTORY_LIMIT":
      throw new ShopifyConsentServiceError("ACTION_HISTORY_LIMIT", "This cart has reached its temporary choice limit.");
    default:
      throw new ShopifyConsentServiceError("RECORD_CONFLICT", "The Shopify cart choice could not be accepted.");
  }
}

export async function prepareCartMarker(input: {
  shopId: string;
  cartToken: string;
  now?: number;
}): Promise<{ marker: string; version: 1; ownerRevision: number }> {
  assertShopId(input.shopId);
  const cartBaseToken = canonicalShopifyCartToken(input.cartToken);
  const digest = shopifyConsentDigest("cart", input.shopId, cartBaseToken);
  const now = input.now ?? Date.now();
  const expiresAtMs = now + SHOPIFY_CONSENT_CART_TTL_MS;
  const marker = `m1_${randomBytes(32).toString("base64url")}`;
  const cartRecord: CartRecord = {
    v: 1,
    shopId: input.shopId,
    cartDigest: digest,
    marker,
    issuedAtMs: now,
    expiresAtMs,
    choiceRevision: 0,
    actionHistory: {},
  };
  const markerRecord = MarkerRecordSchema.parse({
    v: 1,
    shopId: input.shopId,
    cartDigest: digest,
    issuedAtMs: now,
    expiresAtMs,
  });

  const response = await withRedis(client => client.eval(
    PREPARE_CART_SCRIPT,
    2,
    cartKey(input.shopId, digest),
    markerKey(input.shopId, marker),
    JSON.stringify(cartRecord),
    JSON.stringify(markerRecord),
    String(SHOPIFY_CONSENT_CART_TTL_MS),
    MARKER_PREFIX + input.shopId + ":",
    input.shopId,
    digest,
    String(now),
  ) as Promise<string[]>);
  const [code, rawRecord] = response;
  if (code !== "CREATED" && code !== "EXISTING") mapScriptCode(code);
  if (!rawRecord) {
    throw new ShopifyConsentServiceError("RECORD_CORRUPT", "The temporary Shopify cart record is invalid.");
  }
  const persisted = parseCartRecord(rawRecord);
  if (
    persisted.shopId !== input.shopId ||
    persisted.cartDigest !== digest ||
    !isShopifyConsentMarker(persisted.marker) ||
    persisted.expiresAtMs <= now
  ) {
    throw new ShopifyConsentServiceError("RECORD_CONFLICT", "The temporary Shopify cart owner could not be verified.");
  }
  return { marker: persisted.marker, version: 1, ownerRevision: persisted.choiceRevision };
}

export type ExistingConsentState =
  | "GRANTED"
  | "REVOKED"
  | "UNKNOWN"
  | "NO_CUSTOMER"
  | "NO_CONTACT"
  | "AMBIGUOUS"
  | "UNVERIFIED";

export type ShopifyCartConsentStatus = {
  checked: boolean;
  decision: "GRANT" | "REVOKE" | ExistingConsentState;
  source: "current_cart" | "postgresql";
  revision: number | null;
};

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

export async function readCartConsentStatus(input: {
  shopId: string;
  cartToken: string;
  shopifyCustomerId: string | null;
  database?: Pick<PrismaClient, "customer">;
  now?: number;
}): Promise<ShopifyCartConsentStatus> {
  assertShopId(input.shopId);
  const cartBaseToken = canonicalShopifyCartToken(input.cartToken);
  const digest = shopifyConsentDigest("cart", input.shopId, cartBaseToken);
  const now = input.now ?? Date.now();
  const response = await withRedis(client => client.eval(
    READ_CART_SCRIPT,
    1,
    cartKey(input.shopId, digest),
    input.shopId,
    MARKER_PREFIX + input.shopId + ":",
    String(now),
  ) as Promise<string[]>);
  const [code, rawRecord] = response;
  if (code === "CORRUPT" || code === "INCONSISTENT") mapScriptCode(code);
  if (code === "CART") {
    if (!rawRecord) {
      throw new ShopifyConsentServiceError("RECORD_CORRUPT", "The temporary Shopify cart record is invalid.");
    }
    const record = parseCartRecord(rawRecord);
    if (record.shopId !== input.shopId || record.cartDigest !== digest || record.expiresAtMs <= now) {
      throw new ShopifyConsentServiceError("RECORD_CONFLICT", "The current Shopify cart owner could not be verified.");
    }
    if (record.latestExplicitChoice) {
      return {
        checked: record.latestExplicitChoice.decision === "GRANT",
        decision: record.latestExplicitChoice.decision,
        source: "current_cart",
        revision: record.choiceRevision,
      };
    }
  } else if (code !== "NO_CART") {
    mapScriptCode(code);
  }

  const existingState = input.shopifyCustomerId
    ? await readExistingCustomerConsent(
      input.shopId,
      input.shopifyCustomerId,
      input.database ?? prisma,
    )
    : "NO_CUSTOMER";
  return {
    checked: existingState === "GRANTED",
    decision: existingState,
    source: "postgresql",
    revision: null,
  };
}

export async function recordCartChoice(input: {
  shopId: string;
  cartToken: string;
  marker: string;
  actionId: string;
  decision: "GRANT" | "REVOKE";
  disclosureText: string;
  disclosureVersion: string;
  locale: string;
  expectedRevision: number;
  shopifyCustomerIdAtAction: string | null;
  now?: number;
}): Promise<{ acknowledged: true; decision: "GRANT" | "REVOKE"; revision: number }> {
  assertShopId(input.shopId);
  const cartBaseToken = canonicalShopifyCartToken(input.cartToken);
  if (!isShopifyConsentMarker(input.marker)) {
    throw new ShopifyConsentServiceError("INVALID_MARKER", "The current cart marker is invalid.");
  }
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.actionId) ||
    ["__proto__", "constructor", "prototype"].includes(input.actionId) ||
    !DecisionSchema.safeParse(input.decision).success ||
    input.disclosureText !== SHOPIFY_CONSENT_DISCLOSURE_TEXT ||
    input.disclosureVersion !== SHOPIFY_CONSENT_DISCLOSURE_VERSION ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision > MAX_ACTIONS_PER_CART ||
    (input.shopifyCustomerIdAtAction !== null &&
      !/^[1-9]\d{0,19}$/.test(input.shopifyCustomerIdAtAction))
  ) {
    throw new ShopifyConsentServiceError("INVALID_CHOICE", "The Shopify cart choice is invalid.");
  }
  const digest = shopifyConsentDigest("cart", input.shopId, cartBaseToken);
  const now = input.now ?? Date.now();
  const choiceCandidate = {
    actionId: input.actionId,
    decision: input.decision,
    disclosureText: SHOPIFY_CONSENT_DISCLOSURE_TEXT,
    disclosureVersion: SHOPIFY_CONSENT_DISCLOSURE_VERSION,
    locale: input.locale,
    acceptedAtMs: now,
    revision: input.expectedRevision + 1,
    shopifyCustomerIdAtAction: input.shopifyCustomerIdAtAction,
  };
  const parsedChoice = ChoiceSchema.safeParse(choiceCandidate);
  if (!parsedChoice.success) {
    throw new ShopifyConsentServiceError("INVALID_CHOICE", "The Shopify cart choice is invalid.");
  }
  const payloadHash = createHash("sha256")
    .update(JSON.stringify({
      decision: input.decision,
      disclosureText: SHOPIFY_CONSENT_DISCLOSURE_TEXT,
      disclosureVersion: SHOPIFY_CONSENT_DISCLOSURE_VERSION,
      locale: input.locale,
      shopifyCustomerIdAtAction: input.shopifyCustomerIdAtAction,
    }), "utf8")
    .digest("hex");

  const response = await withRedis(client => client.eval(
    RECORD_CHOICE_SCRIPT,
    2,
    cartKey(input.shopId, digest),
    markerKey(input.shopId, input.marker),
    input.shopId,
    digest,
    input.marker,
    input.actionId,
    payloadHash,
    String(input.expectedRevision),
    JSON.stringify(parsedChoice.data),
    String(now),
    String(MAX_ACTIONS_PER_CART),
  ) as Promise<string[]>);
  const [code, revision, rawRecord] = response;
  if (code !== "UPDATED" && code !== "REPLAY") mapScriptCode(code);
  const acceptedRevision = Number(revision);
  if (!Number.isInteger(acceptedRevision) || acceptedRevision < 1) {
    throw new ShopifyConsentServiceError("RECORD_CORRUPT", "The temporary Shopify cart choice is invalid.");
  }
  const currentRecord = rawRecord ? parseCartRecord(rawRecord) : null;
  const currentChoice = currentRecord?.latestExplicitChoice;
  if (!currentChoice) {
    throw new ShopifyConsentServiceError("RECORD_CORRUPT", "The temporary Shopify cart choice is invalid.");
  }
  return {
    acknowledged: true,
    decision: currentChoice.decision,
    revision: currentRecord.choiceRevision,
  };
}

export function logShopifyConsentFailure(input: {
  operation: "app_proxy_authentication" | "shop_resolution" | "status_read" | "cart_prepare" | "cart_choice";
  stage: string;
  error: unknown;
  shopId?: string;
  sensitiveValues?: string[];
  reasonCode?: string;
}): void {
  const consentError = input.error instanceof ShopifyConsentServiceError ? input.error : null;
  logBillingBoundaryFailure({
    event: "shopify.consent.request.failed",
    operation: input.operation,
    stage: input.stage,
    ...(input.shopId ? { shopId: input.shopId } : {}),
    ...(input.reasonCode || consentError ? { reasonCode: input.reasonCode ?? consentError?.code } : {}),
    error: input.error,
    sensitiveValues: input.sensitiveValues,
    ...(consentError?.code === "REDIS_UNAVAILABLE" ? { origin: "transport" as const } : {}),
  });
}
