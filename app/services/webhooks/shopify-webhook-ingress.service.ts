import db from "../../db.server";
import {
  SHOPIFY_COMMERCE_EVENT_SCHEMA_VERSION_V2,
  SHOPIFY_RECOVERY_EVENT_TYPES_V2,
  SHOPIFY_WEBHOOK_QUEUE_CONTRACTS,
  ShopifyCheckoutCreatedEventV2Schema,
  ShopifyCheckoutUpdatedEventV2Schema,
  ShopifyOrderCompletedEventV2Schema,
  createShopifyPendingRecoveryOrderingKey,
  createShopifyOrderCorrelationOrderingKey,
  type CheckoutCreatedPayloadV2,
  type CheckoutUpdatedPayloadV2,
  type OrderCompletedPayloadV2,
} from "@modainteract/moda-interact-shared/shopify";
import {
  parseShopifyWebhookMetadata,
  ShopifyWebhookMetadataError,
  type ShopifyWebhookAuthContext,
} from "./shopify-webhook-metadata";
import {
  ShopifyWebhookPublicationError,
  publishShopifyCheckoutCreatedEvent,
  publishShopifyCheckoutUpdatedEvent,
  publishShopifyOrderCompletedEvent,
} from "./shopify-webhook-queue.server";
import { recordShopifyWebhookOutcome } from "./shopify-webhook-observability.server";
import { getActiveTraceId } from "../otel/otel.runtime";
import {
  normalizeCheckoutCreatedPayload,
  normalizeCheckoutUpdatedPayload,
} from "./checkout-normalization";
import { normalizeOrderCompletedPayload } from "./order-normalization";

type SupportedWebhookPlan =
  | {
      eventType: typeof SHOPIFY_RECOVERY_EVENT_TYPES_V2.CHECKOUT_CREATED;
      queue: typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName;
      normalize: (
        payload: Record<string, unknown>,
      ) => CheckoutCreatedPayloadV2 | null;
      buildOrderingKey: (
        shopId: string,
        payload: CheckoutCreatedPayloadV2,
      ) => string;
    }
  | {
      eventType: typeof SHOPIFY_RECOVERY_EVENT_TYPES_V2.CHECKOUT_UPDATED;
      queue: typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_UPDATED_EVENTS.queueName;
      normalize: (
        payload: Record<string, unknown>,
      ) => CheckoutUpdatedPayloadV2 | null;
      buildOrderingKey: (
        shopId: string,
        payload: CheckoutUpdatedPayloadV2,
      ) => string;
    }
  | {
      eventType: typeof SHOPIFY_RECOVERY_EVENT_TYPES_V2.ORDER_COMPLETED;
      queue: typeof SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName;
      normalize: (
        payload: Record<string, unknown>,
      ) => OrderCompletedPayloadV2 | null;
      buildOrderingKey: (
        shopId: string,
        payload: OrderCompletedPayloadV2,
      ) => string;
    };

type IngressInput = ShopifyWebhookAuthContext & {
  request: Request;
  payload: Record<string, unknown>;
};

export async function ingestShopifyWebhook(
  input: IngressInput,
): Promise<Response> {
  const ackStartedAt = Date.now();
  const requestId = globalThis.crypto.randomUUID();
  const plan = classifyWebhookTopic(input.topic);

  let metadata;
  try {
    metadata = parseShopifyWebhookMetadata(input.request.headers, input);
  } catch (error) {
    if (error instanceof ShopifyWebhookMetadataError) {
      recordShopifyWebhookOutcome({
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
    });

    if (!shop || shop.status !== "ACTIVE") {
      recordShopifyWebhookOutcome({
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
      recordShopifyWebhookOutcome({
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

    let publication;

    if (plan.eventType === SHOPIFY_RECOVERY_EVENT_TYPES_V2.CHECKOUT_CREATED) {
      const normalizedPayload = plan.normalize(input.payload);
      if (!normalizedPayload) {
        recordShopifyWebhookOutcome({
          topic: metadata.providerTopic,
          deliveryId: metadata.deliveryId,
          eventId: metadata.eventId,
          queue: plan.queue,
          jobId: null,
          outcome: "REJECTED_INVALID_CHECKOUT_PAYLOAD",
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

      publication = await publishShopifyCheckoutCreatedEvent({
        event: ShopifyCheckoutCreatedEventV2Schema.parse(event),
      });
    } else if (plan.eventType === SHOPIFY_RECOVERY_EVENT_TYPES_V2.CHECKOUT_UPDATED) {
      const normalizedPayload = plan.normalize(input.payload);
      if (!normalizedPayload) {
        recordShopifyWebhookOutcome({
          topic: metadata.providerTopic,
          deliveryId: metadata.deliveryId,
          eventId: metadata.eventId,
          queue: plan.queue,
          jobId: null,
          outcome: "REJECTED_INVALID_CHECKOUT_PAYLOAD",
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

      publication = await publishShopifyCheckoutUpdatedEvent({
        event: ShopifyCheckoutUpdatedEventV2Schema.parse(event),
      });
    } else {
      const normalizedPayload = plan.normalize(input.payload);
      if (!normalizedPayload) {
        recordShopifyWebhookOutcome({
          topic: metadata.providerTopic,
          deliveryId: metadata.deliveryId,
          eventId: metadata.eventId,
          queue: plan.queue,
          jobId: null,
          outcome: "REJECTED_INVALID_ORDER_PAYLOAD",
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

      publication = await publishShopifyOrderCompletedEvent({
        event: ShopifyOrderCompletedEventV2Schema.parse(event),
      });
    }

    recordShopifyWebhookOutcome({
      topic: metadata.providerTopic,
      deliveryId: metadata.deliveryId,
      eventId: metadata.eventId,
      queue: publication.queue,
      jobId: publication.jobId,
      outcome:
        publication.outcome === "duplicate" ? "DUPLICATE" : "ENQUEUED",
      shopId: shop.id,
      shopDomain: shop.domain,
      ackMs: Date.now() - ackStartedAt,
    });

    return new Response(null, { status: 200 });
  } catch (error) {
    if (error instanceof ShopifyWebhookPublicationError) {
      recordShopifyWebhookOutcome({
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
    | typeof SHOPIFY_RECOVERY_EVENT_TYPES_V2.CHECKOUT_CREATED
    | typeof SHOPIFY_RECOVERY_EVENT_TYPES_V2.CHECKOUT_UPDATED
    | typeof SHOPIFY_RECOVERY_EVENT_TYPES_V2.ORDER_COMPLETED;
  orderingKey: string;
  payload:
    | CheckoutCreatedPayloadV2
    | CheckoutUpdatedPayloadV2
    | OrderCompletedPayloadV2;
}) {
  return {
    schemaVersion: SHOPIFY_COMMERCE_EVENT_SCHEMA_VERSION_V2,
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
    traceId: getActiveTraceId(requestId),
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
    canonicalTopic === "CHECKOUTS_CREATE"
  ) {
    return {
      eventType: SHOPIFY_RECOVERY_EVENT_TYPES_V2.CHECKOUT_CREATED,
      queue: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_EVENTS.queueName,
      normalize: normalizeCheckoutCreatedPayload,
      buildOrderingKey: (shopId, payload) =>
        createShopifyPendingRecoveryOrderingKey(shopId, payload.checkoutToken),
    };
  }

  if (canonicalTopic === "CHECKOUTS_UPDATE") {
    return {
      eventType: SHOPIFY_RECOVERY_EVENT_TYPES_V2.CHECKOUT_UPDATED,
      queue: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.CHECKOUT_UPDATED_EVENTS.queueName,
      normalize: normalizeCheckoutUpdatedPayload,
      buildOrderingKey: (shopId, payload) =>
        createShopifyPendingRecoveryOrderingKey(shopId, payload.checkoutToken),
    };
  }

  if (canonicalTopic === "ORDERS_CREATE") {
    return {
      eventType: SHOPIFY_RECOVERY_EVENT_TYPES_V2.ORDER_COMPLETED,
      queue: SHOPIFY_WEBHOOK_QUEUE_CONTRACTS.ORDER_EVENTS.queueName,
      normalize: normalizeOrderCompletedPayload,
      buildOrderingKey: (shopId, payload) =>
        createShopifyOrderCorrelationOrderingKey({
          shopId,
          orderId: payload.orderId,
          checkoutToken: payload.checkoutToken,
        }),
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

