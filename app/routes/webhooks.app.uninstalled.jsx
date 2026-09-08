import { authenticate } from "../shopify.server";
import db from "../db.server";
import { shopService } from "../services/shop/shop.service";

// @ts-ignore
export const action = async ({ request }) => {
  const { shop, session, triggeredAt } = await authenticate.webhook(request);

  const eventTime = triggeredAt ? new Date(triggeredAt) : new Date();
  await shopService.markUninstalled(
    shop,
    Number.isNaN(eventTime.getTime()) ? new Date() : eventTime,
  );


  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
