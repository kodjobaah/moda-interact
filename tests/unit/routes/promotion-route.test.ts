import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const routeSource = await readFile(
  new URL("../../../app/routes/app/promotions/route.tsx", import.meta.url),
  "utf8",
);
const layoutSource = await readFile(
  new URL("../../../app/routes/app/route.jsx", import.meta.url),
  "utf8",
);

describe("promotion merchant route", () => {
  it("uses promotion-specific localized copy and state", () => {
    expect(routeSource).toContain("promotions.page.title");
    expect(routeSource).toContain("promotions.status.selected");
    expect(routeSource).toContain("promotions.status.exhausted");
    expect(routeSource).toContain("promotions.action.select");
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
    expect(layoutSource).toContain('i18n.t("promotions.nav")');
    expect(layoutSource).not.toContain('>Promotions</s-link>');
  });

  it("renders authored campaign text without internal metadata", () => {
    expect(routeSource).toContain("offer.name");
    expect(routeSource).toContain("offer.merchantDescription");
    for (const internalField of ["platformAdminId", "targetPlanId", "targetShopId", "requestKey", "audit"]) {
      expect(routeSource).not.toContain(internalField);
    }
  });
});
