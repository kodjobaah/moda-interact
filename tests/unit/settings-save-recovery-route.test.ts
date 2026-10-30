import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockPreferenceError extends Error {}
  return {
    logger: { error: vi.fn() },
    MockPreferenceError,
    settingsAccess: vi.fn(),
    saveMerchantRecoveryPolicy: vi.fn(),
    saveFeaturePreferences: vi.fn(),
  };
});

vi.mock("@modainteract/moda-interact-shared/logging", () => ({
  createLogger: vi.fn(() => mocks.logger),
}));
vi.mock("@/services/otel/otel.runtime", () => ({
  resolveDeploymentEnvironmentName: () => "test",
}));
vi.mock("@/services/feature-preferences/access.server", () => ({
  settingsAccess: mocks.settingsAccess,
}));
vi.mock("@/services/feature-preferences/feature-preferences.server", () => ({
  PreferenceError: mocks.MockPreferenceError,
  saveFeaturePreferences: mocks.saveFeaturePreferences,
}));
vi.mock("@/services/recovery-policy/recovery-policy.server", () => ({
  RecoveryPolicyValidationError: class RecoveryPolicyValidationError extends Error {},
  saveMerchantRecoveryPolicy: mocks.saveMerchantRecoveryPolicy,
}));

import { action } from "../../app/routes/app/settings-save/route";

function recoveryForm(
  preference: string | null = "true",
  selectedDiscountIds = "[]",
  recoveryOfferMode = "NONE",
) {
  const form = new FormData();
  form.set("operationId", "operation-123");
  form.set("intent", "recovery");
  form.set("revision", "revision-1");
  form.set("recoveryDelayMinutes", "30");
  form.set("recoveryOfferMode", recoveryOfferMode);
  form.set("selectedDiscountIds", selectedDiscountIds);
  form.set("followUpEnabled", "false");
  form.set("followUpDelayMinutes", "");
  if (preference !== null) form.set("notifyOnInitialRecoveryOutreach", preference);
  return form;
}

async function submit(form: FormData, contentLength?: string) {
  const request = new Request("https://merchant.example/app/settings-save", {
    method: "POST",
    body: form,
  });
  if (contentLength !== undefined)
    request.headers.set("content-length", contentLength);
  return action({ request } as never);
}

async function submitEncoded(body: string, contentLength?: string) {
  const request = new Request("https://merchant.example/app/settings-save", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (contentLength !== undefined)
    request.headers.set("content-length", contentLength);
  return action({ request } as never);
}

describe("recovery settings save route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsAccess.mockResolvedValue({ shop: { id: "shop-123" } });
    mocks.saveMerchantRecoveryPolicy.mockResolvedValue({
      updatedAt: new Date("2026-10-27T12:00:00.000Z"),
    });
  });

  it.each(["true", "false"] as const)("passes explicit %s as a Boolean to persistence", async (value) => {
    const response = await submit(recoveryForm(value));

    expect(response.status).toBe(200);
    expect(mocks.saveMerchantRecoveryPolicy).toHaveBeenCalledWith(
      "shop-123",
      expect.objectContaining({
        notifyOnInitialRecoveryOutreach: value === "true",
        selectedDiscountIds: [],
      }),
      "revision-1",
    );
  });

  it.each([null, "on", "yes"]) ("rejects missing or non-Boolean preference values (%s)", async (value) => {
    const response = await submit(recoveryForm(value));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "INVALID_INPUT" });
    expect(mocks.saveMerchantRecoveryPolicy).not.toHaveBeenCalled();
  });

  it("rejects duplicated preference fields", async () => {
    const form = recoveryForm();
    form.append("notifyOnInitialRecoveryOutreach", "false");
    const response = await submit(form);
    expect(response.status).toBe(400);
    expect(mocks.saveMerchantRecoveryPolicy).not.toHaveBeenCalled();
  });

  it("sorts the selected ID set before saving and never accepts the legacy anchor", async () => {
    const response = await submit(recoveryForm("true", '["zeta","alpha"]', "FIXED"));
    expect(response.status).toBe(200);
    expect(mocks.saveMerchantRecoveryPolicy).toHaveBeenCalledWith(
      "shop-123",
      expect.objectContaining({ selectedDiscountIds: ["alpha", "zeta"] }),
      "revision-1",
    );

    const legacy = recoveryForm();
    legacy.set("fixedShopifyDiscountId", "browser-authority");
    expect((await submit(legacy)).status).toBe(400);
  });

  it.each([
    "not-json",
    "{}",
    '["same","same"]',
    '[""]',
  ])("rejects malformed or duplicate selected IDs (%s)", async (raw) => {
    expect((await submit(recoveryForm("true", raw))).status).toBe(400);
    expect(mocks.saveMerchantRecoveryPolicy).not.toHaveBeenCalled();
  });

  it("rejects selected payloads over 8192 bytes and more than 50 entries", async () => {
    expect((await submitEncoded(`selectedDiscountIds=${"x".repeat(8193)}`)).status).toBe(400);
    expect((await submit(recoveryForm("true", JSON.stringify(Array.from({ length: 51 }, (_, index) => `d${index}`))))).status).toBe(422);
  });

  it.each([undefined, "1"] as const)(
    "rejects a complete oversized form body with Content-Length %s",
    async (contentLength) => {
      const body = new URLSearchParams({
        operationId: "operation-123",
        intent: "recovery",
        revision: "revision-1",
        recoveryOfferMode: "NONE",
        recoveryDelayMinutes: "x".repeat(9000),
        selectedDiscountIds: "[]",
        followUpEnabled: "false",
        followUpDelayMinutes: "",
        notifyOnInitialRecoveryOutreach: "false",
      }).toString();

      const response = await submitEncoded(body, contentLength);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: "INVALID_INPUT" });
      expect(mocks.saveMerchantRecoveryPolicy).not.toHaveBeenCalled();
    },
  );

  it("requires at least one selection in FIXED mode", async () => {
    const response = await submit(recoveryForm("true", "[]", "FIXED"));
    expect(response.status).toBe(422);
    expect(mocks.saveMerchantRecoveryPolicy).not.toHaveBeenCalled();
  });

  it("rejects repeated selectedDiscountIds form keys", async () => {
    const form = recoveryForm();
    form.append("selectedDiscountIds", "[]");
    expect((await submit(form)).status).toBe(400);
    expect(mocks.saveMerchantRecoveryPolicy).not.toHaveBeenCalled();
  });

  it("logs unexpected persistence failures through Shared and rethrows", async () => {
    const error = new Error("database unavailable");
    mocks.saveMerchantRecoveryPolicy.mockRejectedValue(error);

    await expect(submit(recoveryForm())).rejects.toBe(error);
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "merchant.recovery_settings.save.failed",
      {
        shopId: "shop-123",
        operation: "recovery_notice_preference",
        errorCategory: "persistence_failure",
        error,
      },
    );
  });

  it("preserves the existing conflict response without internal failure logging", async () => {
    mocks.saveMerchantRecoveryPolicy.mockRejectedValue(
      new mocks.MockPreferenceError("CONFLICT"),
    );

    const response = await submit(recoveryForm());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, error: "CONFLICT" });
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });
});
