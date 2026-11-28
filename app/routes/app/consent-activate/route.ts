import type { ActionFunctionArgs } from "react-router";
import { settingsMutationAccess } from "@/services/feature-preferences/access.server";
import {
  buildCheckoutEditorUrl,
  ConsentActivationGateError,
  loadCartConsentBlockPresence,
  loadCartConsentSetupSnapshot,
  loadConsentActivation,
  reconcileCartConsentGate,
  resolveConsentPlacement,
  transitionCartConsentSetupPhase,
} from "@/services/shopify-consent/consent-activation.server";
import {
  buildCartConsentThemeActivationUrl,
  buildCartConsentThemeEditorUrl,
} from "@/services/shopify-consent/theme-activation-url.server";
import { logShopifyConsentFailure } from "@/services/shopify-consent/consent-receipt.server";
import { apiKey } from "@/shopify.server";

const response = (data: object, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });

/**
 * Merchant-authorized setup and verification. A theme-editor deep link is an
 * invitation to save, never evidence of consent activation or shopper consent.
 */
export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST")
    return response({ ok: false, error: "INVALID_INPUT" }, 405);
  const { shop, merchant } = await settingsMutationAccess(request, context);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return response({ ok: false, error: "INVALID_INPUT" }, 400);
  }
  const intent = form.get("intent");
  if (
    (intent !== "activate" && intent !== "verify") ||
    [...form.keys()].length !== 1 ||
    form.getAll("intent").length !== 1
  ) {
    return response({ ok: false, error: "INVALID_INPUT" }, 400);
  }

  try {
    const admin = merchant.authentication.admin;
    const placement = await resolveConsentPlacement(admin);
    if (placement === "unknown")
      return response({ ok: false, error: "SETUP_UNAVAILABLE" }, 503);

    if (intent === "verify") {
      const snapshot = await loadConsentActivation({
        admin,
        shopDomain: shop.domain,
        apiKey,
      });
      if (
        snapshot.placement === "non_plus_cart" &&
        snapshot.cartStatus === "active" &&
        snapshot.gateState === "enabled" &&
        snapshot.setupPhase !== "unknown" &&
        snapshot.setupPhase !== "active"
      ) {
        // The published block and availability gate are both verified. This
        // also reconciles older installations whose setup metafield is null.
        const transition = await transitionCartConsentSetupPhase(
          admin,
          snapshot.setupPhase,
          "active",
        );
        if (transition === "conflict") {
          // Another tab won the compare-and-set. Verify the winner actually
          // established Active instead of claiming reconciliation succeeded.
          const latest = await loadCartConsentSetupSnapshot(admin);
          if (latest.setupPhase !== "active") {
            throw new ConsentActivationGateError(
              "Shopify cart consent setup changed during verification.",
            );
          }
        }
      }
      return response({ ok: true, placement, status: snapshot.cartStatus });
    }

    if (placement === "plus_checkout") {
      const gate = await reconcileCartConsentGate(admin, placement);
      const editorUrl = buildCheckoutEditorUrl(shop.domain);
      if (gate !== "disabled" || !editorUrl) {
        throw new ConsentActivationGateError(
          "Shopify Plus checkout activation could not be prepared.",
        );
      }
      return response({ ok: true, placement, editorUrl });
    }

    const setup = await loadCartConsentSetupSnapshot(admin);
    if (setup.gateState === "unknown" || setup.setupPhase === "unknown") {
      return response({ ok: false, error: "SETUP_UNAVAILABLE" }, 503);
    }

    const editorUrl = buildCartConsentThemeEditorUrl({
      shopDomain: shop.domain,
      placement,
    });
    if (!editorUrl)
      return response({ ok: false, error: "SETUP_UNAVAILABLE" }, 503);
    let shouldAddBlock = false;

    // A fresh installation can open Shopify's add-block deep link even if
    // read_themes is unavailable. Do not turn theme verification into a setup
    // prerequisite. Once claimed, repeated requests open only the plain editor.
    if (setup.setupPhase === "never") {
      const presence = await loadCartConsentBlockPresence(admin);
      // Existing stores may already have the availability gate enabled from
      // an older installation. Only auto-add there on positively absent proof.
      const canAutoAdd =
        setup.gateState === "disabled"
          ? presence !== "enabled" &&
            presence !== "disabled" &&
            presence !== "duplicate"
          : presence === "absent";
      if (setup.gateState === "disabled" || canAutoAdd) {
        const claimed = await transitionCartConsentSetupPhase(
          admin,
          "never",
          "started",
          {
            enableGate: setup.gateState === "disabled",
          },
        );
        shouldAddBlock = claimed === "changed" && canAutoAdd;
      }
    } else if (setup.setupPhase === "active" && setup.gateState === "enabled") {
      // Only a previously verified installation that is now positively absent
      // can receive a restoration deep link. Unknown or disabled => manage.
      const presence = await loadCartConsentBlockPresence(admin);
      if (presence === "absent") {
        shouldAddBlock =
          (await transitionCartConsentSetupPhase(
            admin,
            "active",
            "restoring",
          )) === "changed";
      }
    }

    const gate = await reconcileCartConsentGate(admin, placement);
    if (gate !== "enabled") {
      throw new ConsentActivationGateError(
        "Shopify cart consent availability gate could not be enabled.",
      );
    }
    const destination = shouldAddBlock
      ? buildCartConsentThemeActivationUrl({
          shopDomain: shop.domain,
          apiKey,
          placement,
        })
      : editorUrl;
    if (!destination)
      return response({ ok: false, error: "SETUP_UNAVAILABLE" }, 503);
    return response({ ok: true, placement, editorUrl: destination });
  } catch (error) {
    logShopifyConsentFailure({
      operation: "activation_status",
      stage:
        intent === "verify" ? "merchant_verification" : "merchant_activation",
      shopId: shop.id,
      error,
    });
    return response({ ok: false, error: "SETUP_UNAVAILABLE" }, 503);
  }
}
