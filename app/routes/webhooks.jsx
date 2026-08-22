import { authenticate } from "../shopify.server";
import { ordersQueue } from "../queue/order.server";

export const action = async ({ request }) => {
  const { topic, shop, payload } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} from ${shop}`);

  switch (topic) {
    case "CARTS_CREATE":
      console.log("Cart created:", payload);
      break;

    case "CARTS_UPDATE":
      console.log("Cart updated:", payload);
      break;

    case "CHECKOUTS_CREATE":
      console.log("Checkout created:", payload);
      break;

    case "CHECKOUTS_UPDATE":
      console.log("Checkout updated:", payload);
      break;

    case "ORDERS_CREATE":
      const order = {
        shop,

        orderId: payload.admin_graphql_api_id,

        checkoutToken: payload.checkout_token ?? null,

        customerId:
          payload.customer?.admin_graphql_api_id ?? null,

        totalPrice:
          payload.current_total_price ??
          payload.total_price ??
          null,

        currency: payload.currency ?? null,
      };

      await ordersQueue.add(
        "order-completed",
        order,
        {
          jobId: `order:${shop}:${payload.admin_graphql_api_id}`,
        },
      );

      console.log("Order queued", {
        orderId: order.orderId,
        shop: order.shop,
      });
      break;

    default:
      console.log(`Unhandled webhook: ${topic}`);
      break;
  }

  return new Response(null, { status: 200 });
};