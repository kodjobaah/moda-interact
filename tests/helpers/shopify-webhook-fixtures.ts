import {
  ShopifyCheckoutCreatedEventV2Schema, ShopifyCheckoutUpdatedEventV3Schema,
  ShopifyCartActivityEventV2Schema, ShopifyOrderCompletedEventV2Schema,
  ShopifyWhatsAppConsentSyncJobV1Schema, parseShopifyDiscountSyncJob,
  SHOPIFY_WEBHOOK_QUEUE_CONTRACTS as contracts,
} from "@modainteract/moda-interact-shared/shopify";
import {
  createShopifyWebhookJobId, createShopifyOrderJobId,
  createShopifyDiscountSyncJobId, createShopifyWhatsAppConsentSyncJobId,
} from "@modainteract/moda-interact-shared/shopify/node";

export function webhookFixtures(shopId = "shop-a", prefix = "fixture-delivery") {
  const at = "2026-11-01T00:00:00.000Z";
  const base = {schemaVersion: 2, receiptId: "fixture-receipt", eventId: null, source: "shopify",
    tenant: {shopId, shopDomain: `${shopId}.myshopify.com`}, occurredAt: at, receivedAt: at,
    traceId: "fixture-trace", orderingKey: "fixture-ordering"};
  const created = ShopifyCheckoutCreatedEventV2Schema.parse({...base, deliveryId: `${prefix}-created`,
    eventType: "checkout.created", providerTopic: "CHECKOUTS_CREATE", payload: {checkoutToken: "checkout-fixture", cartToken: null, abandonedCheckoutUrl: null, checkoutCreatedAt: at}});
  const updated = ShopifyCheckoutUpdatedEventV3Schema.parse({...base, schemaVersion: 3, deliveryId: `${prefix}-updated`,
    eventType: "checkout.updated", providerTopic: "CHECKOUTS_UPDATE", payload: {checkoutToken: "checkout-fixture", cartToken: null, abandonedCheckoutUrl: null, checkoutCreatedAt: at}});
  const cart = ShopifyCartActivityEventV2Schema.parse({...base, deliveryId: `${prefix}-cart`,
    eventType: "cart.activity", providerTopic: "CARTS_UPDATE", payload: {cartToken: "cart-fixture", isEmpty: null}});
  const order = ShopifyOrderCompletedEventV2Schema.parse({...base, deliveryId: `${prefix}-order`,
    eventType: "order.completed", providerTopic: "ORDERS_CREATE", payload: {orderId: "gid://shopify/Order/42", checkoutToken: null, cartToken: null, completedAt: at}});
  const discount = parseShopifyDiscountSyncJob({schemaVersion: 1, shopId, shopDomain: base.tenant.shopDomain,
    reason: "DISCOUNT_WEBHOOK", requestedAt: at, deliveryId: `${prefix}-discount`, webhookTopic: "discounts/create"});
  const consent = ShopifyWhatsAppConsentSyncJobV1Schema.parse({schemaVersion: 1, shopId,
    shopifyCustomerId: "706405506930370084", deliveryId: `${prefix}-consent`, triggeredAt: at});
  const deliveryId = (id: string) => `${shopId}--${createShopifyWebhookJobId(shopId, id)}`;
  return [
    {publisher: "publishShopifyCheckoutCreatedEvent", event: created, contract: contracts.CHECKOUT_EVENTS, jobId: deliveryId(created.deliveryId)},
    {publisher: "publishShopifyCheckoutUpdatedEvent", event: updated, contract: contracts.CHECKOUT_UPDATED_EVENTS, jobId: deliveryId(updated.deliveryId)},
    {publisher: "publishShopifyCartActivityEvent", event: cart, contract: contracts.CART_ACTIVITY_EVENTS, jobId: deliveryId(cart.deliveryId)},
    {publisher: "publishShopifyOrderCompletedEvent", event: order, contract: contracts.ORDER_EVENTS, jobId: `${shopId}--${createShopifyOrderJobId(shopId, order.payload.orderId)}`},
    {publisher: "publishShopifyDiscountSyncJob", event: discount, contract: contracts.SHOPIFY_DISCOUNT_SYNC, jobId: createShopifyDiscountSyncJobId(discount)},
    {publisher: "publishShopifyWhatsAppConsentSyncJob", event: consent, contract: contracts.WHATSAPP_CONSENT_SYNC, jobId: createShopifyWhatsAppConsentSyncJobId(consent)},
  ] as const;
}
