import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readActiveMerchantPricingCatalogue = vi.fn();

vi.mock("../../../app/services/merchant-pricing/merchant-pricing.server", () => ({
  readActiveMerchantPricingCatalogue,
}));
vi.mock("../../../app/shopify.server", () => ({
  login: vi.fn(),
}));

const { loader } = await import("../../../app/routes/public/home/route");
const routeSource = await readFile(
  new URL("../../../app/routes/public/home/route.jsx", import.meta.url),
  "utf8",
);

function loaderArgs(url: string, headers?: HeadersInit) {
  return { request: new Request(url, { headers }) } as Parameters<typeof loader>[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  readActiveMerchantPricingCatalogue.mockResolvedValue([
    {
      shopifyPlanHandle: "free",
      displayName: "Free",
      planKind: "FREE",
      cataloguePosition: 0,
      featured: false,
      localizedDescription: "Start recovering abandoned checkouts.",
      includedRecoveryCredits: 2,
      allowancePeriod: "LIFETIME",
      billingPeriod: "EVERY_30_DAYS",
      recurringAmountMinor: 0,
      currency: "GBP",
      highlights: [],
      usageEvents: [],
    },
  ]);
});

describe("public home route", () => {
  it("keeps the standalone experience manual and loads the active merchant pricing catalogue", async () => {
    const result = await loader(loaderArgs("https://example.test/", {
      "accept-language": "en-GB,en;q=0.9",
    }));

    expect(result.pricingCatalogue).toHaveLength(1);
    expect(JSON.stringify(result.pricingCatalogue)).not.toContain("shopifyPlanHandle");
    expect(JSON.stringify(result.pricingCatalogue)).not.toContain("usageEvents");
    expect(readActiveMerchantPricingCatalogue).toHaveBeenCalledWith({ locale: "en-GB" });
  });

  it("redirects an embedded Shopify launch into the authenticated app shell", async () => {
    let response: Response | undefined;
    try {
      await loader(loaderArgs(
        "https://example.test/?shop=eugene-bdx7mzhn.myshopify.com&host=encoded&embedded=1",
      ));
    } catch (error) {
      response = error as Response;
    }

    expect(response).toBeInstanceOf(Response);
    expect(response?.headers.get("Location")).toContain(
      "/app?shop=eugene-bdx7mzhn.myshopify.com&host=encoded&embedded=1",
    );
    expect(readActiveMerchantPricingCatalogue).not.toHaveBeenCalled();
  });

  it("does not discover or redirect an unknown custom storefront input", async () => {
    const result = await loader(loaderArgs("https://example.test/?shop=store.custom.example"));

    expect(result).not.toHaveProperty("detectedShop");
    expect(readActiveMerchantPricingCatalogue).toHaveBeenCalledOnce();
    expect(routeSource).toContain("Start installation from your Shopify admin");
    expect(routeSource).not.toMatch(/dns|lookup|resolve.*domain|MYSHOPIFY_DOMAIN/i);
    expect(routeSource).not.toContain("detectedShopFromUrl");
  });

  it("renders contextual connection copy, canonical pricing, and the public Moda Interact link", () => {
    expect(routeSource).toContain('href="https://www.modainteract.com/"');
    expect(routeSource).toContain("Connect your Shopify store");
    expect(routeSource).toContain("MerchantPricingCatalogue");
    expect(routeSource).toContain("showChoosePlanAction={false}");
    expect(routeSource).toContain("Pricing shown here comes from the active Moda Interact merchant catalogue");
  });
});
