import crypto from "node:crypto";
import process from "node:process";
import { authenticate } from "../shopify.server";
import { ordersQueue } from "../lib/queues/order.server";
import { getCheckoutQueue } from "../lib/queues/checkout.queue";
import { normaliseCheckoutCreated } from "../domain/checkout-events";
import db from "../db.server";

const DEFAULT_RECOVERY_DELAY_MINUTES = 30;

// @ts-ignore
export const action = async ({ request }) => {
  const { topic, shop, payload } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} from ${shop}`);

  switch (topic) {
    case "CARTS_CREATE":
      console.log("Cart created:", payload);
    case "CARTS_UPDATE":
      console.log("Cart updated:", payload);
      break;
    case "CHECKOUTS_UPDATE":
      console.log("Checkout updated:", payload);
    case "CHECKOUTS_CREATE":
      const checkout =
        normaliseCheckoutCreated(
          shop,
          payload,
        );

      if (!checkout.checkoutToken) {
        console.error(
          "CHECKOUTS_CREATE missing checkout token",
        );

        return new Response(null, {
          status: 200,
        });
      }

      const queue = getCheckoutQueue();
      const shopRecord = await db.shop.findUnique({
        where: { domain: shop },
        select: {
          settings: {
            select: { recoveryDelayMinutes: true },
          },
        },
      });
      const configuredDelayMinutes = shopRecord?.settings?.recoveryDelayMinutes;
      const fallbackDelayMs = Number(
        process.env.CHECKOUT_RECOVERY_DELAY_MS ?? DEFAULT_RECOVERY_DELAY_MINUTES * 60 * 1000,
      );
      const recoveryDelayMs = configuredDelayMinutes == null
        ? fallbackDelayMs
        : configuredDelayMinutes * 60 * 1000;

      const jobId =
        "checkout-created-" +
        crypto
          .createHash("sha256")
          .update(
            ` ${shop}:${checkout.checkoutToken}:${Date.now()}`,
          )
          .digest("hex");

      await queue.add(
        "checkout-created",
        checkout,
        {
          jobId,
          delay: Number.isFinite(recoveryDelayMs) && recoveryDelayMs >= 0
            ? recoveryDelayMs
            : DEFAULT_RECOVERY_DELAY_MINUTES * 60 * 1000,
        },
      );

      console.log(
        "Checkout queued:",
        {
          shop,
          jobId,
          checkoutToken:
            checkout.checkoutToken,
        },
      );

      break;



    case "ORDERS_CREATE":
      const order = {
        shop,
        orderId: payload.admin_graphql_api_id,

        checkoutToken:
          payload.checkout_token ?? null,

        customerId:
          payload.customer?.admin_graphql_api_id ?? null,

        totalPrice:
          payload.current_total_price ??
          payload.total_price ??
          null,

        currency:
          payload.currency ?? null,
      };

      const safeOrderId =
        payload.admin_graphql_api_id.replace(
          /[^a-zA-Z0-9_-]/g,
          "_",
        );

      const safeShop = shop.replace(
        /[^a-zA-Z0-9_-]/g,
        "_",
      );

      const job = await ordersQueue.add(
        "order-completed",
        order,
        {
          jobId: `order-${safeShop}-${safeOrderId}-${Date.now()}`,
        },
      );

      console.log("BullMQ job queued", {
        jobId: job.id,
        name: job.name,
        queue: job.queueName,
      });

      break;

    default:
      console.log(`Unhandled webhook: ${topic}`);
      break;
  }

  return new Response(null, { status: 200 });
};