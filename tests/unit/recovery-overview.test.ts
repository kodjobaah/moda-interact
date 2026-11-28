import React from "react";
import LegacyBillingUnavailable from "../../app/components/dashboard/LegacyBillingUnavailable";
import { describe, it, expect, vi } from "vitest";
import { renderStaticRoute } from "../fixtures/render-static-route";
import RecoveryOverview, {
  type OverviewProps,
} from "../../app/components/dashboard/RecoveryOverview";
import {
  createMerchantI18n,
  sourceCatalogues,
} from "../../app/utils/merchant-i18n";

import { overviewFixture } from "../fixtures/recovery-overview";
function render(data: OverviewProps) {
  return renderStaticRoute(React.createElement(RecoveryOverview, data), "/app");
}
describe("recovery overview", () => {
  it("renders with the server router without layout-effect warnings", async () => {
    const errors = vi.spyOn(console, "error");
    try {
      const html = await render(overviewFixture());
      expect(html).toContain("/app/recoveries?");
      expect(html).toContain("<form");
      expect(errors.mock.calls.flat().map(String).join("\n")).not.toContain(
        "useLayoutEffect does nothing on the server",
      );
    } finally {
      errors.mockRestore();
    }
  });
  it("shows cohort metrics without mixing currencies or treating unknown values as zero", async () => {
    const html = await render(overviewFixture());
    expect(html).toContain("30%");
    expect(html).toContain("£25.10");
    expect(html).toContain("€40.20");
    expect(html).toContain("excluded from totals");
    expect(html).not.toContain("65.30");
    expect(html).not.toContain("<svg");
  });
  it("preserves date and trusted embed context in list, ongoing and detail links", async () => {
    const html = (await render(overviewFixture())).replaceAll("&amp;", "&");
    for (const path of ["/app/recoveries?", "/app/recoveries/basket-1?"])
      expect(html).toContain(`${path}from=2026-09-01&to=2026-09-20`);
    expect(html).toContain("status=ongoing");
    expect(html).toContain(
      "shop=fixture.myshopify.com&host=aG9zdA%3D%3D&embedded=1",
    );
    expect(html).not.toContain("view=detail");
  });
  it("does not invent a percentage or currency for an empty cohort", async () => {
    const data = overviewFixture();
    Object.assign(data.performance.overview!.summary, {
      started: 0,
      recovered: 0,
      ongoing: 0,
      recoveryRate: null,
      recoveredValues: [],
      unknownValueCount: 0,
    });
    data.performance.overview!.preview = [];
    const html = await render(data);
    expect(html).toContain("—");
    expect(html).not.toContain("0%");
    expect(html).not.toContain("£");
    expect(html).toContain("An empty queue does not indicate recovery health");
  });
  it("shows unavailable instead of zero for unknown-only recovered value", async () => {
    const data = overviewFixture();
    data.performance.overview!.summary.recoveredValues = [];
    expect(await render(data)).toMatch(
      /Recovered checkout value<\/dt><dd>Unavailable/,
    );
  });
  it.each(["invalid", "error"])(
    "retains capacity and retry controls for %s performance",
    async (state) => {
      const data = overviewFixture();
      data.performance.state = state as "invalid" | "error";
      data.performance.overview = null;
      const html = await render(data);
      expect(html).toContain('role="alert"');
      expect(html).toContain("Current recovery capacity");
      expect(html).not.toContain("30%");
    },
  );
  it("hides stale historical metrics with structural loading while retaining capacity", async () => {
    const html = await render({ ...overviewFixture(), busy: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("recovery-overview__skeleton");
    expect(html).not.toContain("30%");
  });
  it("keeps source balances, reservations and known period expiry separate", async () => {
    const data: OverviewProps = overviewFixture();
    data.capacity = {
      availability: "EXHAUSTED",
      paidIncluded: {
        remaining: 0,
        granted: 100,
        reserved: 2,
        periodEnd: "2026-10-01T00:00:00Z",
      },
      freeLifetime: { remaining: 0, granted: 10, reserved: 0 },
      promotional: { remaining: 0, reserved: 0 },
      purchased: { available: 0, reserved: 3, refunding: 4 },
    } as OverviewProps["capacity"];
    const html = await render(data);
    expect(html).toContain("Capacity exhausted");
    expect(html).toContain("Period ends:");
    expect(html).toContain("Promotion expiry: unavailable");
    expect(html).toContain("Refunding: 4");
    expect(html).toContain("Reserved: 3");
    expect(html).toContain("Ada");
  });
  it("preserves pending pagination date/embed context", async () => {
    const data = overviewFixture();
    data.pendingRecoveries.totalPages = 2;
    expect((await render(data)).replaceAll("&amp;", "&")).toContain(
      "/app?shop=fixture.myshopify.com&host=aG9zdA%3D%3D&embedded=1&from=2026-09-01&to=2026-09-20&pendingPage=2",
    );
  });
  it("has complete, formatted overview copy in every supported catalogue", () => {
    const keys = Object.keys(sourceCatalogues.en).filter((key) =>
      key.startsWith("overview."),
    );
    expect(keys).toHaveLength(19);
    for (const [locale, catalogue] of Object.entries(sourceCatalogues)) {
      expect(
        Object.keys(catalogue)
          .filter((key) => key.startsWith("overview."))
          .sort(),
      ).toEqual([...keys].sort());
      const i18n = createMerchantI18n({ locale, timeZone: "UTC" });
      for (const key of keys)
        expect(i18n.t(key, { count: 2, date: "2026-10-01" })).not.toContain(
          "{",
        );
    }
  });
});

it("renders unavailable billing selection without any implicit usage redirect/link", async () => {
  const props = {
    merchantUi: overviewFixture().merchantUi,
    embed: overviewFixture().performance.embed,
  };
  const markup = await renderStaticRoute(
    React.createElement(LegacyBillingUnavailable, props),
    "/app",
  );
  expect(markup).toContain(
    "The requested billing period is unavailable. No other period has been selected.",
  );
  expect(markup).not.toContain("/app/usage");
  expect(markup).toContain("shop=fixture.myshopify.com");
});
