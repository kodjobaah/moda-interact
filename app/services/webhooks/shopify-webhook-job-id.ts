import crypto from "node:crypto";

export function buildShopifyWebhookJobId(
  appKey: string,
  deliveryId: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${appKey}:${deliveryId}`)
    .digest("hex");

  return `shopify-${hash}`;
}
