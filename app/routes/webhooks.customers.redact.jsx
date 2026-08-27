import { authenticate } from "../shopify.server";
import db from "../db.server";

// @ts-ignore
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const shopifyCustomerId = payload.customer?.id
    ? String(payload.customer.id)
    : null;

  if (!shopifyCustomerId) {
    return new Response();
  }

  const shopRecord = await db.shop.findUnique({ where: { domain: shop } });

  if (!shopRecord) {
    return new Response();
  }

  const customer = await db.customer.findUnique({
    where: {
      shopId_shopifyCustomerId: {
        shopId: shopRecord.id,
        shopifyCustomerId,
      },
    },
  });

  if (!customer) {
    return new Response();
  }

  // CheckoutRecovery keeps a required-in-practice link to Customer for recovery
  // and billing history, so we anonymise rather than hard-delete the row.
  await db.customer.update({
    where: { id: customer.id },
    data: {
      email: null,
      phone: null,
      firstName: null,
      lastName: null,
    },
  });

  await db.customerPhone.updateMany({
    where: { customerId: customer.id, endedAt: null },
    data: { endedAt: new Date() },
  });

  return new Response();
};
