import {
  deriveCartTemplateEvidence,
  getCartConsentThemeActivationStatus,
  getPlusCheckoutConsentActivationStatus,
  type ThemeActivationStatus,
} from "./theme-activation-status";
import {
  buildCartConsentThemeActivationUrl,
  type ShopifyConsentPlacement,
} from "./theme-activation-url.server";
import { logShopifyConsentFailure } from "./consent-receipt.server";

export const DEFAULT_APP_PROXY_ROOT = "/apps/moda-consent";

export type AdminGraphqlClient = {
  graphql(query: string): Promise<{
    ok?: boolean;
    status?: number;
    json(): Promise<unknown>;
  }>;
};

export type ConsentActivation = Readonly<{
  placement: ShopifyConsentPlacement;
  cartStatus: ThemeActivationStatus;
  plusStatus: ThemeActivationStatus;
  cartThemeEditorUrl: string | null;
  appProxyDefaultRoot: string;
}>;

const SHOP_PLAN_QUERY = /* GraphQL */ `
  query ModaConsentShopPlan {
    shop {
      plan {
        shopifyPlus
      }
    }
  }
`;

const PUBLISHED_CART_TEMPLATE_QUERY = /* GraphQL */ `
  query ModaConsentPublishedCartTemplate {
    themes(first: 1, roles: [MAIN]) {
      nodes {
        id
        files(filenames: ["templates/cart.json"], first: 1) {
          nodes {
            body {
              ... on OnlineStoreThemeFileBodyText {
                content
              }
            }
          }
        }
      }
    }
  }
`;

async function readGraphqlData(
  admin: AdminGraphqlClient,
  query: string,
): Promise<Record<string, unknown>> {
  const response = await admin.graphql(query);
  const payload = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message?: unknown }>;
  };
  if (response.ok === false || payload?.errors?.length || !payload?.data) {
    throw new Error("Shopify activation evidence unavailable.");
  }
  return payload.data;
}

/**
 * Resolves the single consent placement supported by the merchant's plan.
 * Unresolvable plan evidence is reported as `unknown`; it never silently
 * activates either placement.
 */
export async function resolveConsentPlacement(
  admin: AdminGraphqlClient,
): Promise<ShopifyConsentPlacement> {
  try {
    const data = await readGraphqlData(admin, SHOP_PLAN_QUERY);
    const plan = (data.shop as { plan?: { shopifyPlus?: unknown } } | undefined)?.plan;
    if (typeof plan?.shopifyPlus !== "boolean") return "unknown";
    return plan.shopifyPlus ? "plus_checkout" : "non_plus_cart";
  } catch (error) {
    logShopifyConsentFailure({
      operation: "activation_status",
      stage: "plan_resolution",
      error,
    });
    return "unknown";
  }
}

async function collectCartConsentStatus(
  admin: AdminGraphqlClient,
  placement: ShopifyConsentPlacement,
): Promise<ThemeActivationStatus> {
  if (placement !== "non_plus_cart") {
    return getCartConsentThemeActivationStatus({
      placement,
      publishedThemeAvailable: null,
      cartTemplateSupported: null,
      blockEnabledInPublishedTheme: null,
    });
  }
  try {
    const data = await readGraphqlData(admin, PUBLISHED_CART_TEMPLATE_QUERY);
    const themeNodes = (data.themes as { nodes?: Array<unknown> } | undefined)?.nodes;
    if (!Array.isArray(themeNodes) || themeNodes.length === 0) {
      return getCartConsentThemeActivationStatus({
        placement,
        publishedThemeAvailable: false,
        cartTemplateSupported: null,
        blockEnabledInPublishedTheme: null,
      });
    }
    const fileNodes = (themeNodes[0] as {
      files?: { nodes?: Array<{ body?: { content?: unknown } }> };
    }).files?.nodes;
    const content =
      Array.isArray(fileNodes) && typeof fileNodes[0]?.body?.content === "string"
        ? fileNodes[0].body.content
        : null;
    const evidence = deriveCartTemplateEvidence(content);
    return getCartConsentThemeActivationStatus({
      placement,
      publishedThemeAvailable: true,
      ...evidence,
    });
  } catch (error) {
    logShopifyConsentFailure({
      operation: "activation_status",
      stage: "cart_template_read",
      error,
    });
    return "unavailable";
  }
}

/**
 * Loads the plan-exclusive activation snapshot for the merchant settings UI.
 * Statuses stay truthful: verification failures surface as
 * `unavailable`/`unverified`, never as an invented enabled badge, and the
 * placement not supported by the plan is reported `unsupported`.
 */
export async function loadConsentActivation(input: {
  admin: AdminGraphqlClient;
  shopDomain: string;
  apiKey: string;
}): Promise<ConsentActivation> {
  const placement = await resolveConsentPlacement(input.admin);
  const cartStatus = await collectCartConsentStatus(input.admin, placement);
  const plusStatus = getPlusCheckoutConsentActivationStatus({
    placement,
    // The checkout extension ships with the app; its live render is verified
    // by the extension's own signed status call, not by an Admin API read, so
    // merchant-facing Plus evidence remains explicitly unverified here.
    extensionVerified: null,
  });

  let cartThemeEditorUrl: string | null = null;
  if (placement === "non_plus_cart") {
    try {
      cartThemeEditorUrl = buildCartConsentThemeActivationUrl({
        shopDomain: input.shopDomain,
        apiKey: input.apiKey,
        placement,
      });
    } catch (error) {
      logShopifyConsentFailure({
        operation: "activation_status",
        stage: "theme_editor_url",
        error,
      });
    }
  }

  return {
    placement,
    cartStatus,
    plusStatus,
    cartThemeEditorUrl,
    appProxyDefaultRoot: DEFAULT_APP_PROXY_ROOT,
  };
}
