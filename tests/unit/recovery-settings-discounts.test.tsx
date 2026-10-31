// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../app/utils/merchant-i18n", () => ({
  createMerchantI18n: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    formatDateTime: (value: string | Date) => String(value),
  }),
}));
vi.mock("../../app/components/dashboard/Breadcrumbs", () => ({ default: () => null }));
vi.mock("../../app/components/settings/SettingsForm", () => ({
  default: ({ children }: { children: React.ReactNode }) => <form>{children}</form>,
}));
vi.mock("../../app/components/settings/FeaturePreferences", () => ({ default: () => null }));
vi.mock("../../app/components/settings/StoreProfileSection", () => ({ default: () => null }));
vi.mock("../../app/components/settings/MerchantKnowledgeSection", () => ({ default: () => null }));
vi.mock("../../app/routes/app/recovery-settings/WhatsAppCustomerConsent", () => ({ default: () => null }));

import RecoverySettingsView from "../../app/routes/app/recovery-settings/RecoverySettingsView";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const data = {
  merchantUi: {},
  merchant: {
    recoveryOfferMode: "FIXED",
    fixedShopifyDiscountId: "legacy-anchor",
    followUpEnabled: false,
    followUpDelayMinutes: null,
    recoveryDelayMinutes: 30,
  },
  effective: {
    recoveryOfferMode: "AI_BEST_APPLICABLE",
    recoveryDelayMinutes: 60,
    followUpEnabled: false,
    followUpDelayMinutes: null,
    source: "ADMIN_OVERRIDE",
  },
  revision: "revision-1",
  overrideActive: true,
  catalogueStatus: "ERROR",
  catalogueGeneration: 8,
  selectedDiscountIds: ["selected-but-dormant"],
  discounts: [
    {
      id: "selected-but-dormant",
      title: "Dormant selection",
      summary: null,
      method: "CODE",
      providerStatus: "EXPIRED",
      startsAt: null,
      endsAt: null,
      singleRedeemCode: null,
      fixedSelectable: false,
      isAvailable: true,
      unavailableAt: new Date("2026-10-01T00:00:00.000Z"),
      lastSyncedAt: new Date("2026-10-02T00:00:00.000Z"),
      lastSeenSyncGeneration: 7,
    },
    {
      id: "new-sync-item",
      title: "New sync item",
      summary: null,
      method: "AUTOMATIC",
      providerStatus: "ACTIVE",
      startsAt: null,
      endsAt: null,
      singleRedeemCode: null,
      fixedSelectable: true,
      isAvailable: false,
      unavailableAt: null,
      lastSyncedAt: new Date("2026-10-03T00:00:00.000Z"),
      lastSeenSyncGeneration: 8,
    },
  ],
  notifyOnInitialRecoveryOutreach: false,
  features: { revision: "revision-1", features: [] },
  storeCategories: [],
  storeProfile: { pendingCategory: null, activeCategory: null },
  merchantKnowledge: { configuredCount: 0, maxKnowledgeSources: 0, sources: [] },
};

it("reflects merchant flags rather than provider availability or the legacy anchor", async () => {
  await act(async () => root.render(<RecoverySettingsView data={data as never} />));

  const dormantCheckbox = host.querySelector<HTMLInputElement>(
    '.moda-recovery-discount-card input[value="selected-but-dormant"]',
  );
  const newCheckbox = host.querySelector<HTMLInputElement>(
    '.moda-recovery-discount-card input[value="new-sync-item"]',
  );
  expect(dormantCheckbox?.checked).toBe(true);
  expect(newCheckbox?.checked).toBe(false);
  expect(host.querySelector('input[name="selectedDiscountIds"]')?.getAttribute("value")).toBe(
    '["selected-but-dormant"]',
  );
  expect(host.textContent).toContain("recoverySettings.discount.status.EXPIRED");
  expect(host.textContent).toContain("recoverySettings.discount.syncGeneration");
  expect(host.textContent).toContain("recoverySettings.adminOverride");

  await act(async () => {
    dormantCheckbox!.click();
  });
  expect(host.querySelector<HTMLInputElement>('input[name="selectedDiscountIds"]')?.value).toBe("[]");
});

it("keeps all 50 selections and disables only further unchecked choices", async () => {
  const selectedDiscountIds = Array.from({ length: 50 }, (_, index) => `d-${index}`);
  const discounts = [
    ...selectedDiscountIds.map((id) => ({ ...data.discounts[0], id, title: id })),
    { ...data.discounts[1], id: "d-50", title: "d-50" },
  ];
  await act(async () =>
    root.render(
      <RecoverySettingsView
        data={{ ...data, selectedDiscountIds, discounts } as never}
      />,
    ),
  );

  const hidden = host.querySelector<HTMLInputElement>(
    'input[name="selectedDiscountIds"]',
  );
  const nextChoice = host.querySelector<HTMLInputElement>(
    '.moda-recovery-discount-card input[value="d-50"]',
  );
  expect(JSON.parse(hidden!.value)).toHaveLength(50);
  expect(host.textContent).toContain('"count":50');
  expect(nextChoice?.checked).toBe(false);
  expect(nextChoice?.disabled).toBe(true);
  expect(host.querySelectorAll('.moda-recovery-discount-card input:checked')).toHaveLength(50);
});
