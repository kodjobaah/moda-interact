import { authenticate } from "../shopify.server";

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
      console.log("Order completed:", payload);
      break;

    default:
      console.log(`Unhandled webhook: ${topic}`);
      break;
  }

  return new Response(null, { status: 200 });
};