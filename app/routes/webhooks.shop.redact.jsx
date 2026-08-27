import { authenticate } from "../shopify.server";
import db from "../db.server";

// @ts-ignore
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Session is keyed by shop domain rather than shopId, so it isn't covered
  // by the Shop row's cascading deletes and must be cleaned up separately.
  await db.session.deleteMany({ where: { shop } });

  // Deleting Shop cascades to ShopSettings, ShopBrand, Subscription,
  // UsageEvent, BillingPeriod, Customer, CustomerPhone, CheckoutRecovery,
  // Conversation and ConversationMessage.
  await db.shop.deleteMany({ where: { domain: shop } });

  return new Response();
};
