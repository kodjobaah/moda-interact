import crypto from "node:crypto";

import db from "../../db.server";
import { buildShopifyWebhookJobId } from "./shopify-webhook-job-id";
import {
  parseShopifyWebhookMetadata,
  ShopifyWebhookMetadataError,
  type ShopifyWebhookAuthContext,
} from "./shopify-webhook-metadata";
import { logShopifyWebhookOutcome } from "./shopify-webhook-logger";
import {
  normalizeCheckoutObservedPayload,
  type ShopifyCheckoutObservedPayload,
} from "./checkout-normalization";
import {
  normalizeOrderCompletedPayload,
  type ShopifyOrderCompletedPayload,
} from "./order-normalization";
import type {
  ShopifyWebhookInternalEventType,
  ShopifyWebhookJobV1,
} from "./shopify-webhook-contracts";

type SupportedWebhookPlan =
  | {
      kind: "checkout";
      internalEventType: "checkout.observed";
      normalize: (
        payload: Record<string, unknown>,
      ) => ShopifyCheckoutObservedPayload | null;
    }
  | {
      kind: "order";
      internalEventType: "order.completed";
      normalize: (
        payload: Record<string, unknown>,
      ) => ShopifyOrderCompletedPayload | null;
    };

type IngressInput = ShopifyWebhookAuthContext & {
  request: Request;
  payload: Record<string, unknown>;
};

export async function ingestShopifyWebhook(input: IngressInput): Promise<Response> {
  const ackStartedAt = Date.now();
  const receiptId = crypto.randomUUID();

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
        internalEventType: null,
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
      });

      const plan = classifyWebhookTopic(metadata.providerTopic);

      if (!shop || shop.status !== "ACTIVE") {
        return tx.shopifyWebhookReceipt.create({
          data: {
            id: receiptId,
            appKey: metadata.appKey,
            deliveryId: metadata.deliveryId,
            eventId: metadata.eventId,
            shopId: null,
            shopDomain: metadata.shopDomain,
            providerTopic: metadata.providerTopic,
            internalEventType: plan?.internalEventType ?? null,
            apiVersion: metadata.apiVersion,
            triggeredAt: metadata.triggeredAt,
            triggeredAtRaw: metadata.triggeredAtRaw,
            subscriptionName: metadata.subscriptionName,
            receivedAt: metadata.receivedAt,
            disposition: "QUARANTINED",
            dispositionCode: shop ? "INACTIVE_TENANT" : "UNKNOWN_TENANT",
            rejectedPayload: {
              reason: shop ? "INACTIVE_TENANT" : "UNKNOWN_TENANT",
              providerTopic: metadata.providerTopic,
              eventType: plan?.internalEventType ?? null,
            },
          },
        });
      }

      if (!plan) {
        return tx.shopifyWebhookReceipt.create({
          data: {
            id: receiptId,
            appKey: metadata.appKey,
            deliveryId: metadata.deliveryId,
            eventId: metadata.eventId,
            shopId: null,
            shopDomain: metadata.shopDomain,
            providerTopic: metadata.providerTopic,
            internalEventType: null,
            apiVersion: metadata.apiVersion,
            triggeredAt: metadata.triggeredAt,
            triggeredAtRaw: metadata.triggeredAtRaw,
            subscriptionName: metadata.subscriptionName,
            receivedAt: metadata.receivedAt,
            disposition: "IGNORED",
            dispositionCode: "UNSUPPORTED_TOPIC",
            rejectedPayload: null,
          },
        });
      }

      const normalizedPayload = plan.normalize(input.payload);
      if (!normalizedPayload) {
        return tx.shopifyWebhookReceipt.create({
          data: {
            id: receiptId,
            appKey: metadata.appKey,
            deliveryId: metadata.deliveryId,
            eventId: metadata.eventId,
            shopId: shop.id,
            shopDomain: metadata.shopDomain,
            providerTopic: metadata.providerTopic,
            internalEventType: plan.internalEventType,
            apiVersion: metadata.apiVersion,
            triggeredAt: metadata.triggeredAt,
            triggeredAtRaw: metadata.triggeredAtRaw,
            subscriptionName: metadata.subscriptionName,
            receivedAt: metadata.receivedAt,
            disposition: "REJECTED",
            dispositionCode: "MISSING_CHECKOUT_TOKEN",
            rejectedPayload: {
              reason: "MISSING_CHECKOUT_TOKEN",
              providerTopic: metadata.providerTopic,
              eventType: plan.internalEventType,
            },
          },
        });
      }

      const orderingKey = `${shop.id}:${normalizedPayload.checkoutToken}`;
      const outboxEnvelope = buildWebhookEnvelope({
        receiptId,
        metadata,
        shop,
        internalEventType: plan.internalEventType,
        orderingKey,
        payload: normalizedPayload,
      });

      return tx.shopifyWebhookReceipt.create({
        data: {
          id: receiptId,
          appKey: metadata.appKey,
          deliveryId: metadata.deliveryId,
          eventId: metadata.eventId,
          shopId: shop.id,
          shopDomain: metadata.shopDomain,
          providerTopic: metadata.providerTopic,
          internalEventType: plan.internalEventType,
          apiVersion: metadata.apiVersion,
          triggeredAt: metadata.triggeredAt,
          triggeredAtRaw: metadata.triggeredAtRaw,
          subscriptionName: metadata.subscriptionName,
          receivedAt: metadata.receivedAt,
          disposition: "ACCEPTED",
          dispositionCode: null,
          rejectedPayload: null,
          outbox: {
            create: {
              destination: "SHOPIFY_COMMERCE_EVENTS",
              contractVersion: 1,
              jobId: buildShopifyWebhookJobId(
                metadata.appKey,
                metadata.deliveryId,
              ),
              orderingKey,
              envelope: outboxEnvelope,
              state: "PENDING",
            },
          },
        },
        include: { outbox: true },
      });
    });

    logShopifyWebhookOutcome({
      receiptId: result.id,
      deliveryId: metadata.deliveryId,
      eventId: metadata.eventId,
      providerTopic: metadata.providerTopic,
      internalEventType: result.internalEventType,
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
          internalEventType: existing.internalEventType,
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
      kind: "checkout",
      internalEventType: "checkout.observed",
      normalize: normalizeCheckoutObservedPayload,
    };
  }

  if (canonicalTopic === "ORDERS_CREATE") {
    return {
      kind: "order",
      internalEventType: "order.completed",
      normalize: normalizeOrderCompletedPayload,
    };
  }

  if (canonicalTopic.startsWith("CART")) {
    return null;
  }

  return null;
}

function buildWebhookEnvelope<T>({
  receiptId,
  metadata,
  shop,
  internalEventType,
  orderingKey,
  payload,
}: {
  receiptId: string;
  metadata: { deliveryId: string; eventId: string | null; providerTopic: string; receivedAt: Date; triggeredAtRaw: string | null };
  shop: { id: string; domain: string };
  internalEventType: ShopifyWebhookInternalEventType;
  orderingKey: string;
  payload: T;
}): ShopifyWebhookJobV1<T> {
  return {
    schemaVersion: 1,
    receiptId,
    deliveryId: metadata.deliveryId,
    eventId: metadata.eventId,
    source: "shopify",
    eventType: internalEventType,
    providerTopic: metadata.providerTopic,
    tenant: {
      shopId: shop.id,
      shopDomain: shop.domain,
    },
    occurredAt: metadata.triggeredAtRaw,
    receivedAt: metadata.receivedAt.toISOString(),
    traceId: receiptId,
    orderingKey,
    payload,
  };
}

function isCompositeDeliveryDuplicate(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; meta?: { target?: unknown } };

  return (
    candidate.code === "P2002" &&
    Array.isArray(candidate.meta?.target) &&
    candidate.meta?.target.length === 2 &&
    candidate.meta.target[0] === "appKey" &&
    candidate.meta.target[1] === "deliveryId"
  );
}
