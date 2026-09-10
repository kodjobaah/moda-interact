import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "@/shopify.server";
import { shopService } from "@/services/shop/shop.service";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  if (admin && session) {
    await shopService.resolveShopifyShop({ admin, domain: session.shop });
    await shopService.markInstalled(session.shop);
  }

  return null;
};

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
