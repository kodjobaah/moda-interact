import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  save: vi.fn(),
  recovery: vi.fn(),
}));
vi.mock("../../app/services/feature-preferences/access.server", () => ({
  settingsAccess: mocks.access,
}));
vi.mock(
  "../../app/services/feature-preferences/feature-preferences.server",
  () => ({
    saveFeaturePreferences: mocks.save,
    PreferenceError: class extends Error {},
  }),
);
vi.mock("../../app/services/recovery-policy/recovery-policy.server", () => ({
  saveMerchantRecoveryPolicy: mocks.recovery,
  RecoveryPolicyValidationError: class extends Error {},
}));
import { action } from "../../app/routes/app/settings-save/route";
function request(extra: Record<string, string> = {}) {
  const data = new FormData();
  for (const [k, v] of Object.entries({
    intent: "features",
    operationId: "test-op",
    revision: "revision",
    preferences: JSON.stringify([
      { featureId: "dynamic-feature", enabled: true },
    ]),
    ...extra,
  }))
    data.set(k, v);
  return new Request(
    "https://fixture.test/app/settings-save?shop=forged.myshopify.com",
    { method: "POST", body: data },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ shop: { id: "authenticated-shop" } });
  mocks.save.mockResolvedValue({ revision: "new" });
});
it("uses only authenticated ownership, ignoring caller query shop", async () => {
  expect((await action({ request: request() } as never)).status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(
    "authenticated-shop",
    [{ featureId: "dynamic-feature", enabled: true }],
    "revision",
  );
});
it("rejects forged shopId, blind toggles and malformed desired values", async () => {
  for (const extra of [
    { shopId: "foreign" },
    { intent: "toggle" },
    { preferences: "not-json" },
  ] as Array<Record<string, string>>)
    expect((await action({ request: request(extra) } as never)).status).toBe(
      400,
    );
  expect(mocks.save).not.toHaveBeenCalled();
});
it("authentication failure causes no service writes", async () => {
  mocks.access.mockRejectedValue(new Response(null, { status: 401 }));
  await expect(action({ request: request() } as never)).rejects.toMatchObject({
    status: 401,
  });
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.recovery).not.toHaveBeenCalled();
});
