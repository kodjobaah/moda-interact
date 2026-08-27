import crypto from "node:crypto";

import db from "../../db.server";
import {
  SHOPIFY_COMMERCE_EVENT_TYPES,
  SHOPIFY_WEBHOOK_QUEUE_CONTRACTS,
  createShopifyCommerceOrderingKey,
  createShopifyOrderOrderingKey,
  parseShopifyCommerceEvent,
  type ShopifyCheckoutObservedPayload,
  type ShopifyOrderCompletedPayload,
} from "@modainteract/moda-interact-shared/shopify";
import {
  parseShopifyWebhookMetadata,
  ShopifyWebhookMetadataError,
  type ShopifyWebhookAuthContext,
} from "./shopify-webhook-metadata";
import {
  ShopifyWebhookPublicationError,
  publishShopifyCheckoutObservedEvent,
  publishShopifyOrderCompletedEvent,
} from "./shopify-webhook-queue.server";
import { logShopifyWebhookOutcome } from "./shopify-webhook-logger";
import { normalizeCheckoutObservedPayload } from "./checkout-normalization";
import { normalizeOrderCompletedPayload } from "./order-normalization";

type SupportedWebhookPlan =
  | {
      eventType: typeof SHOPIFY_COMMERCE_EVENT_TYPES.CHECKOUT_OBSERVED;
      queue: typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName;
      normalize: (
        payload: Record<string, unknown>,
      ) => ShopifyCheckoutObservedPayload | null;
      buildOrderingKey: (
        shopId: string,
        payload: ShopifyCheckoutObservedPayload,
      ) => string;
    }
  | {
      eventType: typeof SHOPIFY_COMMERCE_EVENT_TYPES.ORDER_COMPLETED;
      queue: typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName;
      normalize: (
        payload: Record<string, unknown>,
      ) => ShopifyOrderCompletedPayload | null;
      buildOrderingKey: (
        shopId: string,
        payload: ShopifyOrderCompletedPayload,
      ) => string;
    };

type IngressInput = ShopifyWebhookAuthContext & {
  request: Request;
  payload: Record<string, unknown>;
};

const DEFAULT_RECOVERY_DELAY_MINUTES = 30;

export async function ingestShopifyWebhook(
  input: IngressInput,
): Promise<Response> {
  const ackStartedAt = Date.now();
  const requestId = crypto.randomUUID();
  const plan = classifyWebhookTopic(input.topic);

  let metadata;
  try {
    metadata = parseShopifyWebhookMetadata(input.request.headers, input);
  } catch (error) {
    if (error instanceof ShopifyWebhookMetadataError) {
      logShopifyWebhookOutcome({
        topic: input.topic,
        deliveryId: "unknown",
        eventId: null,
        queue: null,
        jobId: null,
        outcome: `REJECTED_${error.code}`,
        shopId: null,
        shopDomain: input.shop,
        ackMs: Date.now() - ackStartedAt,
      });

      return new Response(null, { status: 400 });
    }

    throw error;
  }

  try {
    const shop = await db.shop.findUnique({
      where: { domain: metadata.shopDomain },
      include: { settings: true },
    });

    if (!shop || shop.status !== "ACTIVE") {
      logShopifyWebhookOutcome({
        topic: metadata.providerTopic,
        deliveryId: metadata.deliveryId,
        eventId: metadata.eventId,
        queue: plan?.queue ?? null,
        jobId: null,
        outcome: "QUARANTINED",
        shopId: shop?.id ?? null,
        shopDomain: metadata.shopDomain,
        ackMs: Date.now() - ackStartedAt,
      });

      return new Response(null, { status: 200 });
    }

    if (!plan) {
      logShopifyWebhookOutcome({
        topic: metadata.providerTopic,
        deliveryId: metadata.deliveryId,
        eventId: metadata.eventId,
        queue: null,
        jobId: null,
        outcome: isCartTopic(metadata.providerTopic) ? "IGNORED" : "IGNORED",
        shopId: shop.id,
        shopDomain: shop.domain,
        ackMs: Date.now() - ackStartedAt,
      });

      return new Response(null, { status: 200 });
    }

    const normalizedPayload = plan.normalize(input.payload);
    if (!normalizedPayload) {
      logShopifyWebhookOutcome({
        topic: metadata.providerTopic,
        deliveryId: metadata.deliveryId,
        eventId: metadata.eventId,
        queue: plan.queue,
        jobId: null,
        outcome:
          plan.eventType === SHOPIFY_COMMERCE_EVENT_TYPES.CHECKOUT_OBSERVED
            ? "REJECTED_INVALID_CHECKOUT_PAYLOAD"
            : "REJECTED_INVALID_ORDER_PAYLOAD",
        shopId: shop.id,
        shopDomain: shop.domain,
        ackMs: Date.now() - ackStartedAt,
      });

      return new Response(null, { status: 400 });
    }

    const event = buildShopifyEventEnvelope({
      requestId,
      metadata,
      shop,
      eventType: plan.eventType,
      orderingKey: plan.buildOrderingKey(shop.id, normalizedPayload),
      payload: normalizedPayload,
    });

    const publication =
      plan.eventType === SHOPIFY_COMMERCE_EVENT_TYPES.CHECKOUT_OBSERVED
        ? await publishShopifyCheckoutObservedEvent({
            event: parseShopifyCommerceEvent(event),
            recoveryDelayMinutes:
              shop.settings?.recoveryDelayMinutes ?? DEFAULT_RECOVERY_DELAY_MINUTES,
          })
        : await publishShopifyOrderCompletedEvent({
            event: parseShopifyCommerceEvent(event),
          });

    logShopifyWebhookOutcome({
      topic: metadata.providerTopic,
      deliveryId: metadata.deliveryId,
      eventId: metadata.eventId,
      queue: publication.queue,
      jobId: publication.jobId,
      outcome:
        publication.outcome === "coalesced"
          ? "COALESCED"
          : publication.outcome === "duplicate"
            ? "DUPLICATE"
            : "ENQUEUED",
      shopId: shop.id,
      shopDomain: shop.domain,
      ackMs: Date.now() - ackStartedAt,
    });

    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof ShopifyWebhookPublicationError) {
      logShopifyWebhookOutcome({
        topic: metadata.providerTopic,
        deliveryId: metadata.deliveryId,
        eventId: metadata.eventId,
        queue: plan?.queue ?? null,
        jobId: null,
        outcome: error.code,
        shopId: null,
        shopDomain: metadata.shopDomain,
        ackMs: Date.now() - ackStartedAt,
      });

      return new Response(null, { status: 503 });
    }

    throw error;
  }
}

function buildShopifyEventEnvelope({
  requestId,
  metadata,
  shop,
  eventType,
  orderingKey,
  payload,
}: {
  requestId: string;
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
    receiptId: requestId,
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
    traceId: requestId,
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
      queue: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName,
      normalize: normalizeCheckoutObservedPayload,
      buildOrderingKey: (shopId, payload) =>
        createShopifyCommerceOrderingKey(shopId, payload.checkoutToken),
    };
  }

  if (canonicalTopic === "ORDERS_CREATE") {
    return {
      eventType: SHOPIFY_COMMERCE_EVENT_TYPES.ORDER_COMPLETED,
      queue: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName,
      normalize: normalizeOrderCompletedPayload,
      buildOrderingKey: (shopId, payload) =>
        createShopifyOrderOrderingKey(shopId, payload.orderId),
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
