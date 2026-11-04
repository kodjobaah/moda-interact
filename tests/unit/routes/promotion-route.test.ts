import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeSource = await readFile(
  new URL("../../../app/routes/app/promotions/route.tsx", import.meta.url),
  "utf8",
);
const layoutSource = await readFile(
  new URL("../../../app/routes/app/route.jsx", import.meta.url),
  "utf8",
);
const navigationSource = await readFile(
  new URL("../../../app/components/dashboard/MerchantNavigation.tsx", import.meta.url),
  "utf8",
);

describe("promotion merchant route", () => {
  it("uses promotion-specific localized copy and state", () => {
    expect(routeSource).toContain("promotions.page.title");
    expect(routeSource).toContain("promotions.status.selected");
    expect(routeSource).toContain("promotions.status.exhausted");
    expect(routeSource).toContain("promotions.action.select");
    expect(routeSource).toContain("promotions.history.title");
    expect(routeSource).toContain("promotions.history.granted");
    expect(routeSource).toContain("promotions.status.reopened");
    expect(routeSource).toContain("getMerchantPromotionPage");
    expect(routeSource).toContain("promotionSelection");
    expect(routeSource).toContain("useNavigation");
    expect(routeSource).toContain("useRef");
    expect(routeSource).toContain("submitLockRef");
    expect(routeSource).toContain("guardPromotionSubmit");
    expect(routeSource).toContain("disabled={selectionLocked || submissionInFlight || offer.currentlySelected}");
    expect(routeSource).toContain('className="moda-promotions-lock-notice"');
    for (const rawHistoryText of ["No selected promotion history.", "Granted: ", "Currently selected: ", ">Previous<", ">Next<"]) {
      expect(routeSource).not.toContain(rawHistoryText);
    }
    expect(routeSource).not.toContain("billing.changePlan");
    expect(routeSource).not.toContain("billing.purchasedRecoveryCredits");
  });

  it("maps internal action errors without exposing grant or error details", () => {
    expect(routeSource).toContain('messageKey = error.code === "ACTIVE_PROMOTION_ALREADY_SELECTED"');
    expect(routeSource).toContain('"promotions.error.activeSelected"');
    expect(routeSource).not.toContain("grantId");
    expect(routeSource).not.toContain("error: error.code");
  });

  it("localizes the app navigation label", () => {
    expect(navigationSource).toContain('promotions: "promotions.nav"');
    expect(navigationSource).toContain("i18n.t(keys[item.id])");
    expect(layoutSource).not.toContain(">Promotions</s-link>");
  });

  it("renders authored campaign text without internal metadata", () => {
    expect(routeSource).toContain("offer.merchantTitle");
    expect(routeSource).toContain("offer.merchantDescription");
    expect(routeSource).toContain("entry.campaignTitle ?? i18n.t(\"promotions.history.titleUnavailable\")");
    expect(routeSource).toContain("const promotionLocale = createMerchantI18n(merchantUi).catalogueLocale");
    expect(routeSource).toContain("getMerchantPromotionPage({");
    expect(routeSource).toContain("locale: promotionLocale, offerPage: offerPageValue, historyPage: historyPageValue");
    expect(routeSource).not.toContain("offer.name");
    expect(routeSource).not.toContain("entry.campaignName");
    for (const internalField of ["platformAdminId", "targetPlanId", "targetShopId", "requestKey", "audit"]) {
      expect(routeSource).not.toContain(internalField);
    }
  });

  it("renders a focused current-offer-history merchant experience", () => {
    expect(routeSource).toContain('import "./PromotionsRoute.css"');
    expect(routeSource).toContain('className="moda-promotions-intro"');
    expect(routeSource).toContain('className="moda-promotions-lock-notice"');
    expect(routeSource).toContain('id="current-promotion-heading"');
    expect(routeSource).toContain("const visibleOffers = promotionSelection");
    expect(routeSource).toContain("offer.id !== promotionSelection.campaignId");
    expect(routeSource).toContain('className="moda-promotions-panel"');
    expect(routeSource).toContain('className="moda-promotions-empty"');
    expect(routeSource).toContain('className="moda-promotions-offer-grid"');
    expect(routeSource).toContain('className="moda-promotion-button"');
    expect(routeSource).toContain('className="moda-promotions-history-disclosure"');
    expect(routeSource).toContain('className="moda-promotion-history-list"');
    expect(routeSource).not.toContain('className="moda-promotions-hero-art"');
  });

  it("renders tenant-safe history fields and bounded pagination without mutation controls", () => {
    expect(routeSource).toContain("getPromotionHistory");
    expect(routeSource).toContain("offerPage");
    expect(routeSource).toContain("historyPage");
    expect(routeSource).toContain("offersPagination");
    expect(routeSource).toContain("promotionPageHref");
    expect(routeSource).toContain("entry.quantityGranted");
    expect(routeSource).toContain("entry.committedQuantity");
    expect(routeSource).toContain("entry.remainingQuantity");
    expect(routeSource).toContain("entry.firstSelectedAt");
    expect(routeSource).toContain("entry.lastSelectedAt");
    expect(routeSource).toContain("entry.firstUsedAt");
    expect(routeSource).toContain("entry.lastUsedAt");
    expect(routeSource).toContain("entry.expiresAt");
    expect(routeSource).toContain("entry.currentlySelected");
    expect(routeSource).toContain("history.page - 1");
    expect(routeSource).toContain("history.page + 1");
    expect(routeSource).not.toContain("platformAdminId");
    expect(routeSource).not.toContain("requestKey");
    expect(routeSource).not.toContain("audit");
  });
});


const ports = vi.hoisted(() => ({ context: vi.fn(), page: vi.fn(), select: vi.fn() }));
vi.mock("@/services/shop/merchant-request-context.server", () => ({ getMerchantRequestContext: ports.context }));
vi.mock("@/services/promotions/promotion.service", async importOriginal => ({
  ...await importOriginal<typeof import("../../../app/services/promotions/promotion.service")>(),
  getMerchantPromotionPage: ports.page, selectPromotionOffer: ports.select,
}));
import { action, loader } from "../../../app/routes/app/promotions/route";
import { PromotionSelectionError } from "../../../app/services/promotions/promotion.service";
describe("actual promotion route context and selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ports.context.mockResolvedValue({ shop: { id: "trusted", status: "ACTIVE", onboardingCompleted: true },
      authentication: { session: { shop: "merchant.myshopify.com" } }, readSubscription: async () => ({ status: "ACTIVE", planId: "plan-1" }) });
    ports.page.mockResolvedValue({ offers: [], offersPagination: { page: 1 }, promotionSelection: null, history: { entries: [] } });
    ports.select.mockResolvedValue({ campaignId: "campaign-1" });
  });
  const args = (fields?: Record<string, string>) => ({ request: new Request("https://merchant.test/app/promotions?offerPage=2&historyPage=3", fields ? {
    method: "POST", body: new URLSearchParams(fields),
  } : undefined), context: {} }) as Parameters<typeof loader>[0];
  it("passes scalar tenant/plan context once to the bounded page owner", async () => {
    expect(await loader(args())).toMatchObject({ offers: [], promotionSelection: null });
    expect(ports.page).toHaveBeenCalledWith(expect.objectContaining({ shopId: "trusted", planId: "plan-1", offerPage: 2, historyPage: 3, locale: "en" }));
    expect(ports.context).toHaveBeenCalledOnce();
  });
  it("ignores a form tenant and retains typed normal selection outcomes", async () => {
    expect(await action(args({ campaignId: "campaign-1", shopId: "foreign" }))).toEqual({ ok: true });
    expect(ports.select).toHaveBeenCalledWith("trusted", "campaign-1");
    ports.select.mockRejectedValueOnce(new PromotionSelectionError("ACTIVE_PROMOTION_ALREADY_SELECTED"));
    expect(await action(args({ campaignId: "campaign-1" }))).toEqual({ ok: false, messageKey: "promotions.error.activeSelected" });
  });
  it("preserves authorization before page/selection work", async () => {
    const redirect = new Response(null, { status: 302 }); ports.context.mockRejectedValueOnce(redirect);
    await expect(loader(args())).rejects.toBe(redirect);
    expect(ports.page).not.toHaveBeenCalled(); expect(ports.select).not.toHaveBeenCalled();
  });
});
