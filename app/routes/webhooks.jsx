import crypto from "node:crypto";
import { authenticate } from "../shopify.server";
import { ordersQueue } from "../lib/queues/order.server";
import { getCheckoutQueue } from "../lib/queues/checkout.queue";
import { normaliseCheckoutCreated } from "../domain/checkout-events";

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

      const jobId =
        "checkout-created-" +
        crypto
          .createHash("sha256")
          .update(
            `${shop}:${checkout.checkoutToken}`,
          )
          .digest("hex");

      await queue.add(
        "checkout-created",
        checkout,
        {
          jobId,
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

    case "CHECKOUTS_UPDATE":
      console.log("Checkout updated:", payload);
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