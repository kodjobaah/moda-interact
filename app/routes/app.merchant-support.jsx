import { authenticate } from "../shopify.server";
import { shopService } from "../services/shop/shop.service";
import {
  composeMerchantMessage,
  markMerchantSupportMessageRead,
  readMerchantSupportMessages,
} from "../services/merchant-support/merchant-support.service";

export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  const url = new URL(request.url);
  return Response.json(await readMerchantSupportMessages({
    shopId: shop.id,
    page: Number(url.searchParams.get("page") ?? "1"),
    pageSize: Number(url.searchParams.get("pageSize") ?? "25"),
  }));
}

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const shop = await shopService.resolveShopifyShop({ admin, domain: session.shop });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "compose");

  if (intent === "read") {
    return Response.json({
      marked: await markMerchantSupportMessageRead({
        shopId: shop.id,
        messageId: String(formData.get("messageId") ?? ""),
      }),
    });
  }

  if (intent !== "compose") {
    return Response.json({ error: "Unsupported merchant support action." }, { status: 400 });
  }

  return Response.json(await composeMerchantMessage({
    shopId: shop.id,
    body: String(formData.get("body") ?? ""),
    shopifyUserId: session.userId ?? null,
  }));
}