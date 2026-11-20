import {
  inspectCartConsentTemplate,
  type CartConsentBlockPresence,
  type CartConsentSetupPhase,
  getCartConsentThemeActivationStatus,
  getPlusCheckoutConsentActivationStatus,
  type ThemeActivationStatus,
} from "./theme-activation-status";
import {
  buildCartConsentThemeEditorUrl,
  CART_CONSENT_APP_DATA_METAFIELD,
  type ShopifyConsentPlacement,
} from "./theme-activation-url.server";
import { logShopifyConsentFailure } from "./consent-receipt.server";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "../otel/otel.runtime";

const themeLogger = createLogger({
  serviceName: "moda-interact",
  environment: resolveDeploymentEnvironmentName(),
});

export const DEFAULT_APP_PROXY_ROOT = "/apps/moda-consent";

export type AdminGraphqlClient = {
  graphql(query: string, options?: { variables?: Record<string, unknown> }): Promise<{
    ok?: boolean;
    status?: number;
    json(): Promise<unknown>;
  }>;
};

export type CartConsentGateState = "enabled" | "disabled" | "unknown";
export type CartConsentSetupSnapshot = Readonly<{
  gateState: CartConsentGateState;
  setupPhase: CartConsentSetupPhase;
}>;

export type ConsentActivation = Readonly<{
  placement: ShopifyConsentPlacement;
  cartStatus: ThemeActivationStatus;
  cartBlockPresence: CartConsentBlockPresence;
  plusStatus: ThemeActivationStatus;
  cartThemeEditorUrl: string | null;
  checkoutEditorUrl: string | null;
  gateState: CartConsentGateState;
  setupPhase: CartConsentSetupPhase;
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
            filename
            body {
              ... on OnlineStoreThemeFileBodyText {
                content
              }
            }
          }
          userErrors { code filename }
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

type CartSnapshot = Readonly<{ status: ThemeActivationStatus; presence: CartConsentBlockPresence }>;

async function collectCartConsentStatus(
  admin: AdminGraphqlClient,
  placement: ShopifyConsentPlacement,
): Promise<CartSnapshot> {
  if (placement !== "non_plus_cart") {
    return {
      status: getCartConsentThemeActivationStatus({
        placement,
        publishedThemeAvailable: null,
        cartTemplateSupported: null,
        blockEnabledInPublishedTheme: null,
      }),
      presence: "unknown",
    };
  }
  try {
    const data = await readGraphqlData(admin, PUBLISHED_CART_TEMPLATE_QUERY);
    const themeNodes = (data.themes as { nodes?: Array<unknown> } | undefined)?.nodes;
    if (!Array.isArray(themeNodes) || themeNodes.length === 0) {
      themeLogger.warn("shopify.consent.cart_theme_inspected", {
        operation: "activation_status", outcome: "main_theme_missing", presence: "unknown",
      });
      return { status: "unavailable", presence: "unknown" };
    }
    const theme = themeNodes[0] as {
      id?: unknown;
      files?: {
        nodes?: Array<{ filename?: unknown; body?: { content?: unknown } }>;
        userErrors?: Array<{ code?: unknown; filename?: unknown; message?: unknown }>;
      } | null;
    };
    const files = theme.files;
    if (Array.isArray(files?.userErrors) && files.userErrors.length > 0) {
      const details = files.userErrors.map((item) =>
        `${typeof item.code === "string" ? item.code : "UNKNOWN"} (${typeof item.filename === "string" ? item.filename : "unknown file"}): ${typeof item.message === "string" ? item.message : "No provider message"}`
      ).join("; ");
      throw new Error(`Shopify theme file read failed: ${details}`);
    }
    if (!Array.isArray(files?.nodes)) {
      throw new Error("Shopify did not return a theme files collection.");
    }
    const cartFile = files.nodes.find((item) => item.filename === "templates/cart.json");
    if (typeof cartFile?.body?.content !== "string") {
      throw new Error("The published cart template text was unavailable from Shopify.");
    }
    const inspection = inspectCartConsentTemplate(cartFile.body.content);
    const { presence } = inspection;
    // Report only structural evidence; never log the theme JSON or block settings.
    const diagnostic = {
      operation: "activation_status", stage: "cart_template_read",
      themeId: typeof theme.id === "string" ? theme.id : "unknown",
      outcome: inspection.outcome, presence,
      generatedHeader: inspection.generatedHeader,
      matchingBlocks: inspection.matchingBlocks,
      candidateBlocks: inspection.candidateBlocks,
    };
    if (presence === "unknown" || inspection.candidateBlocks > inspection.matchingBlocks) {
      themeLogger.warn("shopify.consent.cart_theme_inspected", diagnostic);
    } else {
      themeLogger.info("shopify.consent.cart_theme_inspected", diagnostic);
    }
    const status = getCartConsentThemeActivationStatus({
      placement,
      publishedThemeAvailable: true,
      cartTemplateSupported: presence === "unknown" ? null : true,
      blockEnabledInPublishedTheme: presence === "unknown" ? null
        : presence === "enabled" || presence === "duplicate",
    });
    // Multiple published blocks must not be advertised as a clean activation.
    return { status: presence === "duplicate" ? "unverified" : status, presence };
  } catch (error) {
    logShopifyConsentFailure({
      operation: "activation_status",
      stage: "cart_template_read",
      error,
    });
    return { status: "unavailable", presence: "unknown" };
  }
}

/** A fresh, authenticated Admin read before any possible add-block deep link. */
export async function loadCartConsentBlockPresence(
  admin: AdminGraphqlClient,
): Promise<CartConsentBlockPresence> {
  return (await collectCartConsentStatus(admin, "non_plus_cart")).presence;
}


const CART_CONSENT_GATE_QUERY = /* GraphQL */ `
  query ModaConsentCartGate {
    currentAppInstallation {
      id
      metafield(namespace: "${CART_CONSENT_APP_DATA_METAFIELD.namespace}", key: "${CART_CONSENT_APP_DATA_METAFIELD.key}") {
        value
        type
      }
      setupPhase: metafield(namespace: "moda_interact", key: "cart_consent_setup_phase") {
        value
        type
        compareDigest
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

const CART_CONSENT_PHASE_MUTATION = /* GraphQL */ `
  mutation ModaConsentSetupPhaseSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { namespace key value }
      userErrors { code message }
    }
  }
`;

type GateRead = {
  installationId: string;
  value: boolean | null;
  phase: CartConsentSetupPhase;
  phaseDigest: string | null;
};

async function readCartConsentGate(admin: AdminGraphqlClient): Promise<GateRead> {
  const data = await readGraphqlData(admin, CART_CONSENT_GATE_QUERY);
  const installation = data.currentAppInstallation as
    | { id?: unknown; metafield?: { value?: unknown; type?: unknown } | null;
        setupPhase?: { value?: unknown; type?: unknown; compareDigest?: unknown } | null }
    | undefined;
  if (typeof installation?.id !== "string" || installation.id.length === 0) {
    throw new Error("The current app installation could not be resolved.");
  }
  const raw = installation.metafield?.value;
  const value = raw === "true" ? true : raw === "false" ? false : null;
  const phaseField = installation.setupPhase;
  const phaseRaw = phaseField?.value;
  const phase: CartConsentSetupPhase = phaseRaw === undefined || phaseRaw === null
    ? "never"
    : phaseRaw === "started" || phaseRaw === "active" || phaseRaw === "restoring"
      ? phaseRaw : "unknown";
  const digest = phaseField?.compareDigest;
  return {
    installationId: installation.id, value, phase,
    phaseDigest: typeof digest === "string" ? digest : null,
  };
}

/** Read-only status: a missing phase metafield is a genuinely fresh setup. */
export async function loadCartConsentSetupSnapshot(
  admin: AdminGraphqlClient,
): Promise<CartConsentSetupSnapshot> {
  try {
    const gate = await readCartConsentGate(admin);
    return {
      gateState: gate.value === true ? "enabled" : "disabled",
      setupPhase: gate.phase,
    };
  } catch (error) {
    logShopifyConsentFailure({ operation: "activation_status", stage: "gate_read", error });
    return { gateState: "unknown", setupPhase: "unknown" };
  }
}

/**
 * Compare-and-set prevents two tabs from issuing the same add-block link.
 * A mismatch means a competing activation won; callers use the plain editor.
 */
export async function transitionCartConsentSetupPhase(
  admin: AdminGraphqlClient,
  expected: Exclude<CartConsentSetupPhase, "unknown">,
  next: Exclude<CartConsentSetupPhase, "never" | "unknown">,
  options: { enableGate?: boolean } = {},
): Promise<"changed" | "conflict"> {
  const gate = await readCartConsentGate(admin);
  if (gate.phase === "unknown") {
    throw new ConsentActivationGateError("The Shopify cart consent setup marker is invalid.");
  }
  if (gate.phase !== expected) return "conflict";
  if (expected !== "never" && !gate.phaseDigest) {
    throw new ConsentActivationGateError("Shopify omitted the setup marker comparison digest.");
  }
  const metafields: Array<{
    ownerId: string; namespace: string; key: string; type: string;
    value: string; compareDigest?: string | null;
  }> = [{
    ownerId: gate.installationId,
    namespace: "moda_interact",
    key: "cart_consent_setup_phase",
    type: "single_line_text_field",
    value: next,
    compareDigest: expected === "never" ? null : gate.phaseDigest,
  }];
  if (options.enableGate) {
    metafields.push({
      ownerId: gate.installationId,
      namespace: "moda_interact",
      key: "cart_consent_enabled",
      type: "boolean",
      value: "true",
    });
    // The phase compare-and-set guard protects the entire atomic batch.
  }
  const response = await admin.graphql(CART_CONSENT_PHASE_MUTATION, {
    variables: { metafields },
  });
  const payload = await response.json() as {
    data?: { metafieldsSet?: {
      metafields?: Array<{ key?: unknown; value?: unknown }>;
      userErrors?: Array<{ code?: unknown; message?: unknown }>;
    } };
    errors?: Array<{ message?: unknown }>;
  };
  const result = payload?.data?.metafieldsSet;
  if (result?.userErrors?.some((error) => error.code === "STALE_OBJECT")) {
    if (next === "active") {
      themeLogger.warn("shopify.consent.cart_activation_reconciled", {
        operation: "activation_status", previousSetupPhase: expected,
        setupPhase: next, outcome: "conflict",
      });
    }
    return "conflict";
  }
  const userError = result?.userErrors?.[0];
  const persistedPhase = result?.metafields?.find((entry) => entry.key === "cart_consent_setup_phase");
  const persistedGate = result?.metafields?.find((entry) => entry.key === "cart_consent_enabled");
  if (response.ok === false || payload.errors?.length || userError ||
      persistedPhase?.value !== next ||
      (options.enableGate && persistedGate?.value !== "true")) {
    const detail = typeof userError?.message === "string" ? userError.message
      : payload.errors?.map((entry) => entry.message).filter((entry) => typeof entry === "string").join("; ");
    throw new ConsentActivationGateError(
      detail || "Shopify could not save the WhatsApp consent setup progress.",
    );
  }
  if (next === "active") {
    themeLogger.info("shopify.consent.cart_activation_reconciled", {
      operation: "activation_status",
      previousSetupPhase: expected,
      setupPhase: next,
      outcome: "changed",
    });
  }
  return "changed";
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
          metafields?: Array<{ namespace?: unknown; key?: unknown; value?: unknown }>;
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
  const [publishedCart, setup] = await Promise.all([
    collectCartConsentStatus(input.admin, placement),
    placement === "unknown"
      ? Promise.resolve({ gateState: "unknown", setupPhase: "unknown" } as CartConsentSetupSnapshot)
      : loadCartConsentSetupSnapshot(input.admin),
  ]);
  const { gateState, setupPhase } = setup;
  const cartStatus: ThemeActivationStatus =
    placement === "non_plus_cart" && publishedCart.status === "active"
      ? gateState === "enabled" ? "active" : gateState === "unknown" ? "unavailable" : "inactive"
      : publishedCart.status;
  const plusStatus = getPlusCheckoutConsentActivationStatus({
    placement,
    extensionVerified: null, // Browser App Bridge activation evidence is authoritative.
  });

  let cartThemeEditorUrl: string | null = null;
  if (placement === "non_plus_cart") {
    try {
      cartThemeEditorUrl = buildCartConsentThemeEditorUrl({
        shopDomain: input.shopDomain,
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
    cartBlockPresence: publishedCart.presence,
    plusStatus,
    cartThemeEditorUrl,
    checkoutEditorUrl: placement === "plus_checkout"
      ? buildCheckoutEditorUrl(input.shopDomain) : null,
    gateState,
    setupPhase,
    appProxyDefaultRoot: DEFAULT_APP_PROXY_ROOT,
  };
}
