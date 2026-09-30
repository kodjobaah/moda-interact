import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryRouter,
  RouterProvider,
  type LoaderFunctionArgs,
} from "react-router";
import { readFileSync } from "node:fs";
import {
  recoveryDetailUrl,
  type DetailData,
} from "../../app/routes/app/recovery-detail/state";
import RecoveryDetail, {
  MessageText,
} from "../../app/routes/app/recovery-detail/RecoveryDetail";
import { InvalidRecoveryDetailQuery } from "../../app/services/recoveries/detail-cursor.server";
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  shop: vi.fn(),
  settings: vi.fn(),
  subscription: vi.fn(),
  detail: vi.fn(),
  messages: vi.fn(),
  related: vi.fn(),
}));
vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: mocks.authenticate },
}));
vi.mock("../../app/services/shop/shop.service", () => ({
  shopService: { resolveShopifyShop: mocks.shop },
}));
vi.mock("../../app/services/billing/billing.service", () => ({
  billingService: { getSubscription: mocks.subscription },
}));
vi.mock("../../app/db.server", () => ({
  default: { shopSettings: { findUnique: mocks.settings } },
}));
vi.mock("../../app/services/recoveries/recovery-detail.server", () => ({
  readRecoveryDetail: mocks.detail,
  readRecoveryMessages: mocks.messages,
  readRelatedRecoveries: mocks.related,
}));
const { loadRecoveryDetail, loadRecoverySection } =
  await import("../../app/routes/app/recovery-detail/loader.server");
const args = (search = "", recoveryId = "owned-recovery") =>
  ({
    request: new Request(
      `https://app.test/app/recoveries/${recoveryId}?${search}`,
    ),
    params: { recoveryId },
  }) as unknown as LoaderFunctionArgs;
const page = { items: [], previousCursor: null, nextCursor: null };
const detail = {
  id: "owned-recovery",
  customer: {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test",
  },
  status: "COMPLETED",
  value: { amount: "100.25", currency: "GBP", incomplete: false },
  hasConversation: true,
  milestones: {
    detectedAt: "2026-09-10T23:30:00.000Z",
    messageSentAt: null,
    engagedAt: null,
    completedAt: null,
    expiredAt: null,
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({
    admin: {},
    session: { shop: "owned.myshopify.com", locale: "en-GB" },
  });
  mocks.shop.mockResolvedValue({ id: "owned-shop", status: "ACTIVE" });
  mocks.settings.mockResolvedValue({
    onboardingCompleted: true,
    defaultTimeZone: "Europe/London",
  });
  mocks.subscription.mockResolvedValue({ status: "ACTIVE" });
  mocks.detail.mockResolvedValue(detail);
  mocks.messages.mockResolvedValue(page);
  mocks.related.mockResolvedValue(page);
});
const loaders = [
  loadRecoveryDetail,
  (a: LoaderFunctionArgs) => loadRecoverySection(a, "messages"),
  (a: LoaderFunctionArgs) => loadRecoverySection(a, "related"),
];
describe.each(loaders)("independent guarded endpoint", (loader) => {
  it.each(["ACTIVE", "NO_CONTRACT", "FROZEN", "BILLING_ATTENTION"])(
    "allows %s using authenticated ownership",
    async (status) => {
      mocks.subscription.mockResolvedValue({ status });
      await loader(
        args(
          "shopId=foreign&conversationId=foreign&customerId=foreign&shop=evil",
        ),
      );
      const called = [mocks.detail, mocks.messages, mocks.related].filter(
        (mock) => mock.mock.calls.length,
      );
      for (const mock of called) {
        expect(mock).toHaveBeenCalledWith(
          expect.objectContaining({
            shopId: "owned-shop",
            recoveryId: "owned-recovery",
          }),
        );
        expect(mock.mock.invocationCallOrder[0]).toBeGreaterThan(
          mocks.subscription.mock.invocationCallOrder[0],
        );
        expect(JSON.stringify(mock.mock.calls)).not.toContain("foreign");
      }
    },
  );
  it.each([
    ["SUSPENDED", null, true],
    ["UNINSTALLED", new Date(), true],
    ["UNINSTALLED", null, true],
    ["ACTIVE", null, false],
  ] as const)(
    "denies %s without recovery reads",
    async (status, reinstallPendingAt, onboardingCompleted) => {
      mocks.shop.mockResolvedValue({
        id: "owned-shop",
        status,
        reinstallPendingAt,
      });
      mocks.settings.mockResolvedValue({ onboardingCompleted });
      await expect(loader(args())).rejects.toBeInstanceOf(Response);
      expect(mocks.detail).not.toHaveBeenCalled();
      expect(mocks.messages).not.toHaveBeenCalled();
      expect(mocks.related).not.toHaveBeenCalled();
    },
  );
  it("propagates authentication before business data", async () => {
    const denied = new Response(null, { status: 401 });
    mocks.authenticate.mockRejectedValue(denied);
    await expect(loader(args())).rejects.toBe(denied);
    expect(mocks.shop).not.toHaveBeenCalled();
  });
  it("makes missing and foreign IDs indistinguishable", async () => {
    mocks.detail.mockResolvedValue(null);
    mocks.messages.mockResolvedValue(null);
    mocks.related.mockResolvedValue(null);
    const missing = await loader(args("", "missing")),
      foreign = await loader(args("", "foreign"));
    expect(missing).toEqual(foreign);
    expect(missing.init?.status).toBe(404);
  });
});
it("keeps valid list context, discards arbitrary return URLs and resets forged cursors", async () => {
  const result = await loadRecoveryDetail(
    args(
      "from=2026-09-01&to=2026-09-10&status=ongoing&q=Ada&returnTo=https://evil.test&shopId=foreign&host=YWJj&embedded=1",
    ),
  );
  expect(result.data.filters).toMatchObject({
    from: "2026-09-01",
    to: "2026-09-10",
    q: "Ada",
    status: "ongoing",
  });
  const url = recoveryDetailUrl(
    "other/basket",
    result.data.filters,
    result.data.embed,
  );
  expect(url).toContain("/other%2Fbasket?");
  expect(url).toContain("q=Ada");
  expect(url).not.toMatch(/evil|foreign|returnTo/);
  const reset = await loadRecoveryDetail(args("cursor=forged&q=Ada"));
  expect(reset.data.filters.cursor).toBeNull();
  expect(reset.data.filters.q).toBe("");
});
it("contains section failures and retries with bounded reader input", async () => {
  mocks.messages.mockRejectedValue(new Error("SECRET DATABASE DATA"));
  const result = await loadRecoveryDetail(args());
  expect(result.data.detail).toEqual(detail);
  expect(result.data.messages.state).toBe("error");
  expect(result.data.related.state).toBe("ready");
  expect(JSON.stringify(result)).not.toContain("SECRET");
  mocks.messages.mockRejectedValue(new InvalidRecoveryDetailQuery());
  expect(
    (await loadRecoverySection(args("cursor=bad"), "messages")).init?.status,
  ).toBe(400);
  mocks.messages.mockResolvedValue(page);
  await loadRecoverySection(args("window=latest"), "messages");
  expect(mocks.messages).toHaveBeenLastCalledWith({
    shopId: "owned-shop",
    recoveryId: "owned-recovery",
    window: "latest",
    cursor: undefined,
  });
});
it("does not query transcript or related for unavailable detail", async () => {
  mocks.detail.mockResolvedValue(null);
  await loadRecoveryDetail(args());
  expect(mocks.messages).not.toHaveBeenCalled();
  expect(mocks.related).not.toHaveBeenCalled();
});
it("escapes markup and only links explicit http(s), without credential URLs", () => {
  const html = renderToStaticMarkup(
    createElement(MessageText, {
      text: "<script>alert(1)</script> javascript:alert(1) data:text/html,hi https://example.test/long https://user:secret@example.test",
    }),
  );
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain('href="https://example.test/long"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).not.toContain('href="javascript');
  expect(html).not.toContain('href="https://user:');
});
it("renders sender, audio, unknown, receipt, RTL and merchant-local date semantics", async () => {
  const result = await loadRecoveryDetail(args());
  const d = result.data as DetailData;
  d.messages.page = {
    ...page,
    items: [
      {
        id: "a",
        createdAt: detail.milestones.detectedAt,
        direction: "INBOUND",
        sender: "CUSTOMER",
        content: {
          type: "TEXT",
          text: "مرحبا <img src=x>",
          transcriptionStatus: null,
        },
        delivery: null,
      },
      {
        id: "b",
        createdAt: detail.milestones.detectedAt,
        direction: "OUTBOUND",
        sender: "AUTOMATION",
        content: { type: "AUDIO", text: null, transcriptionStatus: "REJECTED" },
        delivery: {
          status: "READ",
          sentAt: detail.milestones.detectedAt,
          deliveredAt: null,
          readAt: null,
        },
      },
      {
        id: "c",
        createdAt: detail.milestones.detectedAt,
        direction: null,
        sender: null,
        content: { type: "UNSUPPORTED", text: null, transcriptionStatus: null },
        delivery: null,
      },
    ],
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: createElement(RecoveryDetail, { data: d, onRefresh: () => {} }),
    },
  ]);
  const html = renderToStaticMarkup(createElement(RouterProvider, { router }));
  expect(html).toContain("Automated message");
  expect(html).toContain("Transcription rejected");
  expect(html).toContain("Unknown sender");
  expect(html).toContain("Unsupported message");
  expect(html).toContain('dir="auto"');
  expect(html).toContain("11 Sept 2026");
  expect(html).not.toContain("<img");
  expect(html).not.toMatch(/<audio|<textarea|providerMediaId/);
});
it("registers sibling detail and independently guarded resources without inheriting list loader", () => {
  const source = readFileSync("app/routes.ts", "utf8");
  expect(source).toContain('route("recoveries/:recoveryId",');
  expect(source).toContain('route("app/recoveries/:recoveryId/messages",');
  const detailSource = readFileSync(
    "app/routes/app/recovery-detail/loader.server.ts",
    "utf8",
  );
  expect(detailSource).not.toContain("readRecoveryPage");
});
