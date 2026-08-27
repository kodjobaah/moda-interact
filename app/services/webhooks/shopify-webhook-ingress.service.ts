import crypto from "node:crypto";

import db from "../../db.server";
import {
  createShopifyCommerceOrderingKey,
  createShopifyOrderOrderingKey,
  parseShopifyCommerceEvent,
  SHOPIFY_COMMERCE_EVENT_TYPES,
  SHOPIFY_WEBHOOK_OUTBOX_DESTINATIONS,
  type ShopifyCheckoutObservedPayload,
  type ShopifyCommerceEvent,
  type ShopifyOrderCompletedPayload,
} from "@modainteract/moda-interact-shared/shopify";
import { createShopifyWebhookJobId } from "@modainteract/moda-interact-shared/shopify/node";
import {
  parseShopifyWebhookMetadata,
  ShopifyWebhookMetadataError,
  type ShopifyWebhookAuthContext,
} from "./shopify-webhook-metadata";
import { logShopifyWebhookOutcome } from "./shopify-webhook-logger";
import { normalizeCheckoutObservedPayload } from "./checkout-normalization";
import { normalizeOrderCompletedPayload } from "./order-normalization";

type SupportedWebhookPlan =
  | {
      eventType: typeof SHOPIFY_COMMERCE_EVENT_TYPES.CHECKOUT_OBSERVED;
      destination: typeof SHOPIFY_WEBHOOK_OUTBOX_DESTINATIONS.CHECKOUT_EVENTS;
      jobName: "checkout-created";
      normalize: (
        payload: Record<string, unknown>,
      ) => ShopifyCheckoutObservedPayload | null;
      buildOrderingKey: (
        shopId: string,
        payload: ShopifyCheckoutObservedPayload,
      ) => string;
      delayMs: (recoveryDelayMinutes: number) => number;
    }
  | {
      eventType: typeof SHOPIFY_COMMERCE_EVENT_TYPES.ORDER_COMPLETED;
      destination: typeof SHOPIFY_WEBHOOK_OUTBOX_DESTINATIONS.ORDER_EVENTS;
      jobName: "order-completed";
      normalize: (
        payload: Record<string, unknown>,
      ) => ShopifyOrderCompletedPayload | null;
      buildOrderingKey: (
        shopId: string,
        payload: ShopifyOrderCompletedPayload,
      ) => string;
      delayMs: () => number;
    };

type IngressInput = ShopifyWebhookAuthContext & {
  request: Request;
  payload: Record<string, unknown>;
};

type ReceiptCreateData = {
  id: string;
  appKey: string;
  deliveryId: string;
  eventId: string | null;
  shopId: string | null;
  shopDomain: string;
  topic: string;
  apiVersion: string | null;
  triggeredAt: Date | null;
  triggeredAtRaw: string | null;
  subscriptionName: string | null;
  receivedAt: Date;
  disposition: "ACCEPTED" | "IGNORED" | "REJECTED" | "QUARANTINED";
  dispositionCode: string | null;
  rejectedPayload: Record<string, unknown> | null;
  outbox?: {
    create: {
      destination: string;
      jobName: string;
      jobId: string;
      orderingKey: string;
      payload: ShopifyCommerceEvent;
      delayMs: number;
      state: "PENDING";
    };
  };
};

export async function ingestShopifyWebhook(
  input: IngressInput,
): Promise<Response> {
  const ackStartedAt = Date.now();
  const receiptId = crypto.randomUUID();
  const plan = classifyWebhookTopic(input.topic);

  let metadata;
  try {
    metadata = parseShopifyWebhookMetadata(input.request.headers, input);
  } catch (error) {
    if (error instanceof ShopifyWebhookMetadataError) {
      logShopifyWebhookOutcome({
        receiptId: null,
        deliveryId: "unknown",
        eventId: null,
        providerTopic: input.topic,
        eventType: plan?.eventType ?? null,
        destination: plan?.destination ?? null,
        shopId: null,
        shopDomain: input.shop,
        disposition: `REJECTED_${error.code}`,
        duplicate: false,
        transactionMs: 0,
        ackMs: Date.now() - ackStartedAt,
      });

      return new Response(null, { status: 400 });
    }

    throw error;
  }

  try {
    const transactionStartedAt = Date.now();
    const result = await db.$transaction(async (tx) => {
      const shop = await tx.shop.findUnique({
        where: { domain: metadata.shopDomain },
        include: { settings: true },
      });

      if (!shop || shop.status !== "ACTIVE") {
        return tx.shopifyWebhookReceipt.create({
          data: buildReceiptData({
            receiptId,
            metadata,
            shopId: null,
            disposition: "QUARANTINED",
            dispositionCode: shop ? "INACTIVE_TENANT" : "UNKNOWN_TENANT",
            rejectedPayload: {
              reason: shop ? "INACTIVE_TENANT" : "UNKNOWN_TENANT",
              providerTopic: metadata.providerTopic,
              eventType: plan?.eventType ?? null,
              destination: plan?.destination ?? null,
            },
          }),
        });
      }

      if (!plan) {
        return tx.shopifyWebhookReceipt.create({
          data: buildReceiptData({
            receiptId,
            metadata,
            shopId: shop.id,
            disposition: "IGNORED",
            dispositionCode: isCartTopic(metadata.providerTopic)
              ? "CART_TOPIC"
              : "UNSUPPORTED_TOPIC",
            rejectedPayload: null,
          }),
        });
      }

      const normalizedPayload = plan.normalize(input.payload);
      if (!normalizedPayload) {
        return tx.shopifyWebhookReceipt.create({
          data: buildReceiptData({
            receiptId,
            metadata,
            shopId: shop.id,
            disposition: "REJECTED",
            dispositionCode:
              plan.eventType === SHOPIFY_COMMERCE_EVENT_TYPES.CHECKOUT_OBSERVED
                ? "INVALID_CHECKOUT_PAYLOAD"
                : "INVALID_ORDER_PAYLOAD",
            rejectedPayload: {
              reason:
                plan.eventType === SHOPIFY_COMMERCE_EVENT_TYPES.CHECKOUT_OBSERVED
                  ? "INVALID_CHECKOUT_PAYLOAD"
                  : "INVALID_ORDER_PAYLOAD",
              providerTopic: metadata.providerTopic,
              eventType: plan.eventType,
              destination: plan.destination,
            },
          }),
        });
      }

      const orderingKey = plan.buildOrderingKey(shop.id, normalizedPayload);
      const envelope = parseShopifyCommerceEvent(
        buildShopifyEventEnvelope({
          receiptId,
          metadata,
          shop,
          eventType: plan.eventType,
          orderingKey,
          payload: normalizedPayload,
        }),
      );

      const delayMs =
        plan.eventType === SHOPIFY_COMMERCE_EVENT_TYPES.CHECKOUT_OBSERVED
          ? plan.delayMs(shop.settings?.recoveryDelayMinutes ?? 30)
          : plan.delayMs();

      return tx.shopifyWebhookReceipt.create({
        data: buildReceiptData({
          receiptId,
          metadata,
          shopId: shop.id,
          disposition: "ACCEPTED",
          dispositionCode: null,
          rejectedPayload: null,
          outbox: {
            create: {
              destination: plan.destination,
              jobName: plan.jobName,
              jobId: createShopifyWebhookJobId(
                metadata.appKey,
                metadata.deliveryId,
              ),
              orderingKey,
              payload: envelope,
              delayMs,
              state: "PENDING",
            },
          },
        }),
        include: { outbox: true },
      });
    });

    logShopifyWebhookOutcome({
      receiptId: result.id,
      deliveryId: metadata.deliveryId,
      eventId: metadata.eventId,
      providerTopic: metadata.providerTopic,
      eventType: plan?.eventType ?? null,
      destination: plan?.destination ?? result.outbox?.destination ?? null,
      shopId: result.shopId,
      shopDomain: result.shopDomain,
      disposition: result.disposition,
      duplicate: false,
      transactionMs: Date.now() - transactionStartedAt,
      ackMs: Date.now() - ackStartedAt,
    });

    return new Response(null, { status: 200 });
  } catch (error) {
    if (isCompositeDeliveryDuplicate(error)) {
      const existing = await db.shopifyWebhookReceipt.findUnique({
        where: {
          appKey_deliveryId: {
            appKey: metadata.appKey,
            deliveryId: metadata.deliveryId,
          },
        },
      });

      if (existing) {
        logShopifyWebhookOutcome({
          receiptId: existing.id,
          deliveryId: metadata.deliveryId,
          eventId: metadata.eventId,
          providerTopic: metadata.providerTopic,
          eventType: plan?.eventType ?? null,
          destination: plan?.destination ?? null,
          shopId: existing.shopId,
          shopDomain: existing.shopDomain,
          disposition: existing.disposition,
          duplicate: true,
          transactionMs: 0,
          ackMs: Date.now() - ackStartedAt,
        });

        return new Response(null, { status: 200 });
      }
    }

    throw error;
  }
}

function buildReceiptData(input: {
  receiptId: string;
  metadata: {
    appKey: string;
    deliveryId: string;
    eventId: string | null;
    shopDomain: string;
    providerTopic: string;
    apiVersion: string | null;
    triggeredAt: Date | null;
    triggeredAtRaw: string | null;
    subscriptionName: string | null;
    receivedAt: Date;
  };
  shopId: string | null;
  disposition: "ACCEPTED" | "IGNORED" | "REJECTED" | "QUARANTINED";
  dispositionCode: string | null;
  rejectedPayload: Record<string, unknown> | null;
  outbox?: {
    create: {
      destination: string;
      jobName: string;
      jobId: string;
      orderingKey: string;
      payload: ShopifyCommerceEvent;
      delayMs: number;
      state: "PENDING";
    };
  };
}): ReceiptCreateData {
  return {
    id: input.receiptId,
    appKey: input.metadata.appKey,
    deliveryId: input.metadata.deliveryId,
    eventId: input.metadata.eventId,
    shopId: input.shopId,
    shopDomain: input.metadata.shopDomain,
    topic: input.metadata.providerTopic,
    apiVersion: input.metadata.apiVersion,
    triggeredAt: input.metadata.triggeredAt,
    triggeredAtRaw: input.metadata.triggeredAtRaw,
    subscriptionName: input.metadata.subscriptionName,
    receivedAt: input.metadata.receivedAt,
    disposition: input.disposition,
    dispositionCode: input.dispositionCode,
    rejectedPayload: input.rejectedPayload,
    outbox: input.outbox,
  };
}

function buildShopifyEventEnvelope({
  receiptId,
  metadata,
  shop,
  eventType,
  orderingKey,
  payload,
}: {
  receiptId: string;
  metadata: {
    deliveryId: string;
    eventId: string | null;
    providerTopic: string;
    triggeredAt: Date | null;
    receivedAt: Date;
  };
  shop: { id: string; domain: string };
  eventType:
    | typeof SHOPIFY_COMMERCE_EVENT_TYPES.CHECKOUT_OBSERVED
    | typeof SHOPIFY_COMMERCE_EVENT_TYPES.ORDER_COMPLETED;
  orderingKey: string;
  payload: ShopifyCheckoutObservedPayload | ShopifyOrderCompletedPayload;
}) {
  return {
    schemaVersion: 1,
    receiptId,
    deliveryId: metadata.deliveryId,
    eventId: metadata.eventId,
    source: "shopify",
    eventType,
    providerTopic: metadata.providerTopic,
    tenant: {
      shopId: shop.id,
      shopDomain: shop.domain,
    },
    occurredAt: metadata.triggeredAt ? metadata.triggeredAt.toISOString() : null,
    receivedAt: metadata.receivedAt.toISOString(),
    traceId: receiptId,
    orderingKey,
    payload,
  };
}

function classifyWebhookTopic(
  providerTopic: string,
): SupportedWebhookPlan | null {
  const canonicalTopic = providerTopic
    .trim()
    .toUpperCase()
    .replaceAll("/", "_")
    .replaceAll(".", "_")
    .replaceAll("-", "_");

  if (
    canonicalTopic === "CHECKOUTS_CREATE" ||
    canonicalTopic === "CHECKOUTS_UPDATE"
  ) {
    return {
      eventType: SHOPIFY_COMMERCE_EVENT_TYPES.CHECKOUT_OBSERVED,
      destination: SHOPIFY_WEBHOOK_OUTBOX_DESTINATIONS.CHECKOUT_EVENTS,
      jobName: "checkout-created",
      normalize: normalizeCheckoutObservedPayload,
      buildOrderingKey: (shopId, payload) =>
        createShopifyCommerceOrderingKey(shopId, payload.checkoutToken),
      delayMs: (recoveryDelayMinutes) => recoveryDelayMinutes * 60_000,
    };
  }

  if (canonicalTopic === "ORDERS_CREATE") {
    return {
      eventType: SHOPIFY_COMMERCE_EVENT_TYPES.ORDER_COMPLETED,
      destination: SHOPIFY_WEBHOOK_OUTBOX_DESTINATIONS.ORDER_EVENTS,
      jobName: "order-completed",
      normalize: normalizeOrderCompletedPayload,
      buildOrderingKey: (shopId, payload) =>
        payload.checkoutToken
          ? createShopifyCommerceOrderingKey(shopId, payload.checkoutToken)
          : createShopifyOrderOrderingKey(shopId, payload.orderId),
      delayMs: () => 0,
    };
  }

  return null;
}

function isCartTopic(providerTopic: string): boolean {
  return providerTopic
    .trim()
    .toUpperCase()
    .replaceAll("/", "_")
    .replaceAll(".", "_")
    .replaceAll("-", "_")
    .startsWith("CART");
}

function isCompositeDeliveryDuplicate(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; meta?: { target?: unknown } };

  return (
    candidate.code === "P2002" &&
    Array.isArray(candidate.meta?.target) &&
    candidate.meta.target.length === 2 &&
    candidate.meta.target[0] === "appKey" &&
    candidate.meta.target[1] === "deliveryId"
  );
}