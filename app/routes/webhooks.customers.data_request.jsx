import { authenticate } from "../shopify.server";
import db from "../db.server";

// @ts-ignore
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // No automated export pipeline yet: durably record the request so it can be
  // fulfilled manually within Shopify's required response window.
  const shopRecord = await db.shop.findUnique({ where: { domain: shop } });

  console.log("customers/data_request received", {
    shop,
    shopId: shopRecord?.id ?? null,
    shopifyShopId: payload.shop_id,
    dataRequestId: payload.data_request?.id,
    customerId: payload.customer?.id,
    customerEmail: payload.customer?.email,
    customerPhone: payload.customer?.phone,
    ordersRequested: payload.orders_requested,
  });

  return new Response();
};
