import type { ActionFunctionArgs } from "react-router";
import { settingsMutationAccess } from "@/services/feature-preferences/access.server";
import {
  buildCheckoutEditorUrl,
  ConsentActivationGateError,
  reconcileCartConsentGate,
  resolveConsentPlacement,
} from "@/services/shopify-consent/consent-activation.server";
import { buildCartConsentThemeActivationUrl } from "@/services/shopify-consent/theme-activation-url.server";
import { logShopifyConsentFailure } from "@/services/shopify-consent/consent-receipt.server";
import { apiKey } from "@/shopify.server";

const response = (data: object, status = 200) => Response.json(data, {
  status,
  headers: { "Cache-Control": "no-store" },
});

/**
 * Single merchant-initiated activation operation. Never trusts a client plan
 * or writes consent. The only mutation is the existing Shopify app-data gate.
 */
export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") return response({ ok: false, error: "INVALID_INPUT" }, 405);
  const { shop, merchant } = await settingsMutationAccess(request, context);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return response({ ok: false, error: "INVALID_INPUT" }, 400);
  }
  if (form.get("intent") !== "activate" ||
      [...form.keys()].length !== 1 || form.getAll("intent").length !== 1) {
    return response({ ok: false, error: "INVALID_INPUT" }, 400);
  }
  try {
    const admin = merchant.authentication.admin;
    const placement = await resolveConsentPlacement(admin);
    if (placement === "unknown") return response({ ok: false, error: "SETUP_UNAVAILABLE" }, 503);

    // Validate navigation destination before changing the Shopify gate.
    const editorUrl = placement === "non_plus_cart"
      ? buildCartConsentThemeActivationUrl({ shopDomain: shop.domain, apiKey, placement })
      : buildCheckoutEditorUrl(shop.domain);
    if (!editorUrl) return response({ ok: false, error: "SETUP_UNAVAILABLE" }, 503);

    const gate = await reconcileCartConsentGate(admin, placement);
    if (gate !== (placement === "non_plus_cart" ? "enabled" : "disabled")) {
      throw new ConsentActivationGateError("Shopify app-data gate reconciliation returned an unexpected state.");
    }
    return response({ ok: true, placement, editorUrl });
  } catch (error) {
    logShopifyConsentFailure({
      operation: "activation_status",
      stage: "merchant_activation",
      shopId: shop.id,
      error,
    });
    return response({ ok: false, error: "SETUP_UNAVAILABLE" }, 503);
  }
}
