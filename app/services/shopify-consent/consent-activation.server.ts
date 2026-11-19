import {
  deriveCartTemplateEvidence,
  getCartConsentThemeActivationStatus,
  getPlusCheckoutConsentActivationStatus,
  type ThemeActivationStatus,
} from "./theme-activation-status";
import {
  buildCartConsentThemeActivationUrl,
  CART_CONSENT_APP_DATA_METAFIELD,
  type ShopifyConsentPlacement,
} from "./theme-activation-url.server";
import { logShopifyConsentFailure } from "./consent-receipt.server";

export const DEFAULT_APP_PROXY_ROOT = "/apps/moda-consent";

export type AdminGraphqlClient = {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<{
    ok?: boolean;
    status?: number;
    json(): Promise<unknown>;
  }>;
};

export type CartConsentGateState = "enabled" | "disabled" | "unknown";

export type ConsentActivation = Readonly<{
  placement: ShopifyConsentPlacement;
  cartStatus: ThemeActivationStatus;
  plusStatus: ThemeActivationStatus;
  cartThemeEditorUrl: string | null;
  checkoutEditorUrl: string | null;
  gateState: CartConsentGateState;
  appProxyDefaultRoot: string;
}>;

export class ConsentActivationGateError extends Error {
  readonly code = "SETUP_UNAVAILABLE";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConsentActivationGateError";
  }
}

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
    const message = payload?.errors?.map((error) => error.message).filter(
      (value): value is string => typeof value === "string",
    ).join("; ");
    throw new Error(message || `Shopify activation query failed (HTTP ${response.status ?? "unknown"}).`);
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


const CART_CONSENT_GATE_QUERY = /* GraphQL */ `
  query ModaConsentCartGate {
    currentAppInstallation {
      id
      metafield(namespace: "${CART_CONSENT_APP_DATA_METAFIELD.namespace}", key: "${CART_CONSENT_APP_DATA_METAFIELD.key}") {
        value
        type
      }
    }
  }
`;

const CART_CONSENT_GATE_MUTATION = /* GraphQL */ `
  mutation ModaConsentCartGateSet($ownerId: ID!, $value: String!) {
    metafieldsSet(metafields: [{
      ownerId: $ownerId,
      namespace: "${CART_CONSENT_APP_DATA_METAFIELD.namespace}",
      key: "${CART_CONSENT_APP_DATA_METAFIELD.key}",
      type: "boolean",
      value: $value
    }]) {
      metafields { value }
      userErrors { field message }
    }
  }
`;

type GateRead = { installationId: string; value: boolean | null };

async function readCartConsentGate(admin: AdminGraphqlClient): Promise<GateRead> {
  const data = await readGraphqlData(admin, CART_CONSENT_GATE_QUERY);
  const installation = data.currentAppInstallation as
    | { id?: unknown; metafield?: { value?: unknown; type?: unknown } | null }
    | undefined;
  if (typeof installation?.id !== "string" || installation.id.length === 0) {
    throw new Error("The current app installation could not be resolved.");
  }
  const raw = installation.metafield?.value;
  const value = raw === "true" ? true : raw === "false" ? false : null;
  return { installationId: installation.id, value };
}

/**
 * Reads the `moda_interact.cart_consent_enabled` app-data availability gate
 * for display only. Never writes.
 */
export async function loadCartConsentGateState(
  admin: AdminGraphqlClient,
): Promise<CartConsentGateState> {
  try {
    const gate = await readCartConsentGate(admin);
    return gate.value === true ? "enabled" : "disabled";
  } catch (error) {
    logShopifyConsentFailure({
      operation: "activation_status",
      stage: "gate_read",
      error,
    });
    return "unknown";
  }
}

/**
 * Idempotently reconciles the existing cart App Block availability gate on an
 * authenticated merchant activation action: `true` for non-Plus, `false` for
 * Plus. Verifies the mutation result and never reports success on a failed
 * write. Must not be called from GET/loader paths.
 */
export async function reconcileCartConsentGate(
  admin: AdminGraphqlClient,
  placement: ShopifyConsentPlacement,
): Promise<CartConsentGateState> {
  if (placement === "unknown") {
    throw new ConsentActivationGateError(
      "The Shopify plan could not be verified; no gate reconciliation was attempted.",
    );
  }
  const desired = placement === "non_plus_cart";
  try {
    const gate = await readCartConsentGate(admin);
    if (gate.value === desired) return desired ? "enabled" : "disabled";

    const response = await admin.graphql(CART_CONSENT_GATE_MUTATION, {
      variables: { ownerId: gate.installationId, value: desired ? "true" : "false" },
    });
    const payload = (await response.json()) as {
      data?: {
        metafieldsSet?: {
          metafields?: Array<{ value?: unknown }>;
          userErrors?: Array<{ message?: unknown }>;
        };
      };
      errors?: Array<{ message?: unknown }>;
    };
    const result = payload?.data?.metafieldsSet;
    const userError = result?.userErrors?.find(
      (entry) => typeof entry?.message === "string",
    );
    if (response.ok === false || payload?.errors?.length || userError) {
      throw new Error(
        typeof userError?.message === "string"
          ? userError.message
          : "The Shopify metafieldsSet mutation was rejected.",
      );
    }
    const written = result?.metafields?.[0]?.value;
    if (written !== (desired ? "true" : "false")) {
      throw new Error("The availability gate write could not be verified.");
    }
    return desired ? "enabled" : "disabled";
  } catch (error) {
    logShopifyConsentFailure({
      operation: "activation_status",
      stage: "gate_write",
      error,
    });
    throw error instanceof ConsentActivationGateError
      ? error
      : new ConsentActivationGateError(
          "The cart consent availability gate could not be reconciled.",
          { cause: error },
        );
  }
}

export function buildCheckoutEditorUrl(shopDomain: string): string | null {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain)
    ? `https://${shopDomain}/admin/settings/checkout`
    : null;
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
  // The loader must stay read-only: the gate changes only after an explicit
  // authenticated merchant POST. Include its status to avoid false Active UI.
  const [publishedCartStatus, gateState] = await Promise.all([
    collectCartConsentStatus(input.admin, placement),
    placement === "unknown"
      ? Promise.resolve("unknown" as CartConsentGateState)
      : loadCartConsentGateState(input.admin),
  ]);
  const cartStatus: ThemeActivationStatus =
    placement === "non_plus_cart" && publishedCartStatus === "active"
      ? gateState === "enabled" ? "active" : gateState === "unknown" ? "unavailable" : "inactive"
      : publishedCartStatus;
  const plusStatus = getPlusCheckoutConsentActivationStatus({
    placement,
    extensionVerified: null, // Browser App Bridge activation evidence is authoritative.
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
    checkoutEditorUrl: placement === "plus_checkout"
      ? buildCheckoutEditorUrl(input.shopDomain) : null,
    gateState,
    appProxyDefaultRoot: DEFAULT_APP_PROXY_ROOT,
  };
}
