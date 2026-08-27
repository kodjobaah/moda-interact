/**
 * Durable outbox dispatch: records the authenticated webhook and (for
 * accepted topics) a queued outbox row inside a single Prisma write, then
 * returns 200 only after that commit succeeds. This module must never
 * import Redis or BullMQ — outbox mode does not require either to
 * acknowledge Shopify.
 */
import { Prisma } from "@prisma/client";
import db from "../../../db.server";
import { normaliseCheckoutCreated } from "../../../domain/checkout-events";
import { normaliseOrderCreated } from "../../../domain/order-events";
import { classifyTopic } from "../webhook-classification";
import { resolveCheckoutDelayMs } from "../checkout-delay.server";
import { buildWebhookJobId } from "../job-id";
import { logWebhookOutcome } from "../webhook-logger.server";

/**
 * @param {import("../webhook-metadata").ShopifyWebhookMetadata} metadata
 * @param {Record<string, any>} payload
 * @param {number} startedAt
 */
export async function dispatchOutbox(metadata, payload, startedAt) {
  const shop = await db.shop.findUnique({
    where: { domain: metadata.shopDomain },
    select: { id: true },
  });

  if (!shop) {
    const { receipt, duplicate } = await createReceipt(metadata, "QUARANTINED", {
      rejectedPayload: payload,
    });
    logOutcome(metadata, receipt, "QUARANTINED", startedAt, duplicate);
    return new Response(null, { status: 200 });
  }

  const classification = classifyTopic(metadata.topic);

  if (classification.kind === "ignored" || classification.kind === "unknown") {
    const { receipt, duplicate } = await createReceipt(metadata, "IGNORED", {
      shopId: shop.id,
    });
    logOutcome(metadata, receipt, "IGNORED", startedAt, duplicate, shop.id);
    return new Response(null, { status: 200 });
  }

  let outboxInput;

  if (classification.kind === "checkout") {
    const checkout = normaliseCheckoutCreated(metadata.shopDomain, payload);

    if (!checkout.checkoutToken) {
      const { receipt, duplicate } = await createReceipt(metadata, "REJECTED", {
        shopId: shop.id,
        rejectedPayload: payload,
      });
      logOutcome(metadata, receipt, "REJECTED", startedAt, duplicate, shop.id);
      return new Response(null, { status: 200 });
    }

    outboxInput = {
      destination: "CHECKOUT_EVENTS",
      jobName: "checkout-created",
      payload: checkout,
      delayMs: await resolveCheckoutDelayMs(metadata.shopDomain),
    };
  } else {
    const order = normaliseOrderCreated(metadata.shopDomain, payload);

    if (!order.orderId) {
      const { receipt, duplicate } = await createReceipt(metadata, "REJECTED", {
        shopId: shop.id,
        rejectedPayload: payload,
      });
      logOutcome(metadata, receipt, "REJECTED", startedAt, duplicate, shop.id);
      return new Response(null, { status: 200 });
    }

    outboxInput = {
      destination: "ORDER_EVENTS",
      jobName: "order-completed",
      payload: order,
      delayMs: 0,
    };
  }

  const jobId = buildWebhookJobId(metadata.appKey, metadata.deliveryId);

  try {
    const receipt = await db.shopifyWebhookReceipt.create({
      data: {
        ...baseReceiptData(metadata, "ACCEPTED"),
        shopId: shop.id,
        outbox: {
          create: {
            destination: outboxInput.destination,
            jobName: outboxInput.jobName,
            jobId,
            payload: outboxInput.payload,
            delayMs: outboxInput.delayMs,
            state: "PENDING",
          },
        },
      },
      include: { outbox: true },
    });

    logOutcome(metadata, receipt, "ACCEPTED", startedAt, false, shop.id);
    return new Response(null, { status: 200 });
  } catch (error) {
    if (isDeliveryIdConflict(error)) {
      const existing = await db.shopifyWebhookReceipt.findUniqueOrThrow({
        where: {
          appKey_deliveryId: {
            appKey: metadata.appKey,
            deliveryId: metadata.deliveryId,
          },
        },
        include: { outbox: true },
      });

      logOutcome(metadata, existing, existing.disposition, startedAt, true, shop.id);
      return new Response(null, { status: 200 });
    }

    throw error;
  }
}

/**
 * @param {import("../webhook-metadata").ShopifyWebhookMetadata} metadata
 * @param {"ACCEPTED" | "IGNORED" | "REJECTED" | "QUARANTINED"} disposition
 */
function baseReceiptData(metadata, disposition) {
  return {
    appKey: metadata.appKey,
    deliveryId: metadata.deliveryId,
    eventId: metadata.eventId,
    shopDomain: metadata.shopDomain,
    topic: metadata.topic,
    apiVersion: metadata.apiVersion,
    triggeredAt: metadata.triggeredAt,
    triggeredAtRaw: metadata.triggeredAtRaw,
    subscriptionName: metadata.subscriptionName,
    receivedAt: metadata.receivedAt,
    disposition,
  };
}

/**
 * Creates a receipt with no outbox row, tolerating the same
 * `[appKey, deliveryId]` race as the accepted path.
 *
 * @param {import("../webhook-metadata").ShopifyWebhookMetadata} metadata
 * @param {"IGNORED" | "REJECTED" | "QUARANTINED"} disposition
 * @param {{ shopId?: string | null, rejectedPayload?: Record<string, any> }} [extra]
 */
async function createReceipt(metadata, disposition, extra = {}) {
  try {
    const receipt = await db.shopifyWebhookReceipt.create({
      data: {
        ...baseReceiptData(metadata, disposition),
        shopId: extra.shopId ?? null,
        rejectedPayload: extra.rejectedPayload,
      },
    });
    return { receipt, duplicate: false };
  } catch (error) {
    if (isDeliveryIdConflict(error)) {
      const existing = await db.shopifyWebhookReceipt.findUniqueOrThrow({
        where: {
          appKey_deliveryId: {
            appKey: metadata.appKey,
            deliveryId: metadata.deliveryId,
          },
        },
      });
      return { receipt: existing, duplicate: true };
    }
    throw error;
  }
}

/**
 * @param {unknown} error
 */
function isDeliveryIdConflict(error) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    error.meta.target.includes("appKey") &&
    error.meta.target.includes("deliveryId")
  );
}

/**
 * @param {import("../webhook-metadata").ShopifyWebhookMetadata} metadata
 * @param {{ id: string }} receipt
 * @param {string} disposition
 * @param {number} startedAt
 * @param {boolean} duplicate
 * @param {string | null} [shopId]
 */
function logOutcome(metadata, receipt, disposition, startedAt, duplicate, shopId) {
  logWebhookOutcome({
    receiptId: receipt.id,
    deliveryId: metadata.deliveryId,
    eventId: metadata.eventId,
    topic: metadata.topic,
    shopId: shopId ?? null,
    shopDomain: metadata.shopDomain,
    disposition,
    durationMs: Date.now() - startedAt,
    duplicate,
  });
}
