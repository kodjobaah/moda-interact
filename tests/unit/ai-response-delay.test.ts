import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockPreferenceError extends Error {
    constructor(message: string) {
      super(message);
    }
  }
  const shopSettings = {
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const transaction = { shopSettings };
  return {
    MockPreferenceError,
    lockSettingsShop: vi.fn(),
    shopSettings,
    transaction,
    client: {
      $transaction: vi.fn((callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    },
  };
});

vi.mock("@/db.server", () => ({ default: mocks.client }));
vi.mock("@/services/feature-preferences/feature-preferences.server", () => ({
  PreferenceError: mocks.MockPreferenceError,
  lockSettingsShop: mocks.lockSettingsShop,
}));

import {
  AiResponseDelayValidationError,
  parseAiResponseDelayFormValue,
  saveAiResponseDelay,
} from "@/services/ai-response-delay/ai-response-delay.server";

const shopId = "shop-authenticated";
const updatedAt = new Date("2026-10-31T10:00:00.000Z");

describe("AI response delay settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.shopSettings.findUnique.mockResolvedValue({
      aiResponseDelayMinutes: 5,
      updatedAt,
    });
    mocks.shopSettings.update.mockImplementation(({ data }) =>
      Promise.resolve({
        aiResponseDelayMinutes: data.aiResponseDelayMinutes,
        updatedAt: data.updatedAt,
      }),
    );
  });

  it.each([0, 1, 7, 30])("accepts %i minutes", (value) => {
    expect(parseAiResponseDelayFormValue(String(value))).toBe(value);
  });

  it.each(["", "-1", "31", "1.5", "01", "+1", " 1", "1 ", "1e1", "NaN", 1, null])(
    "rejects invalid form value %s",
    (value) => {
      expect(() => parseAiResponseDelayFormValue(value)).toThrow(
        AiResponseDelayValidationError,
      );
    },
  );

  it("locks the authenticated shop and updates only delay and revision", async () => {
    const result = await saveAiResponseDelay(
      shopId,
      "7",
      updatedAt.toISOString(),
      mocks.client as never,
    );

    expect(mocks.client.$transaction).toHaveBeenCalledOnce();
    expect(mocks.lockSettingsShop).toHaveBeenCalledWith(
      mocks.transaction,
      shopId,
    );
    expect(mocks.shopSettings.findUnique).toHaveBeenCalledWith({
      where: { shopId },
      select: { aiResponseDelayMinutes: true, updatedAt: true },
    });
    expect(mocks.shopSettings.update).toHaveBeenCalledWith({
      where: { shopId },
      data: {
        aiResponseDelayMinutes: 7,
        updatedAt: expect.any(Date),
      },
      select: { aiResponseDelayMinutes: true, updatedAt: true },
    });
    expect(result.aiResponseDelayMinutes).toBe(7);
  });

  it.each([0, 1, 7, 30])("persists the accepted delay value %i", async (value) => {
    const result = await saveAiResponseDelay(
      shopId,
      String(value),
      updatedAt.toISOString(),
      mocks.client as never,
    );
    expect(mocks.shopSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId },
        data: {
          aiResponseDelayMinutes: value,
          updatedAt: expect.any(Date),
        },
      }),
    );
    expect(result.aiResponseDelayMinutes).toBe(value);
  });

  it("scopes reads and writes independently to each requested shop", async () => {
    await saveAiResponseDelay(
      "shop-one",
      "7",
      updatedAt.toISOString(),
      mocks.client as never,
    );
    await saveAiResponseDelay(
      "shop-two",
      "7",
      updatedAt.toISOString(),
      mocks.client as never,
    );

    expect(mocks.shopSettings.findUnique.mock.calls.map(([input]) => input.where)).toEqual([
      { shopId: "shop-one" },
      { shopId: "shop-two" },
    ]);
    expect(mocks.shopSettings.update.mock.calls.map(([input]) => input.where)).toEqual([
      { shopId: "shop-one" },
      { shopId: "shop-two" },
    ]);
  });

  it("does not write when the submitted value is unchanged", async () => {
    const result = await saveAiResponseDelay(
      shopId,
      "5",
      updatedAt.toISOString(),
      mocks.client as never,
    );

    expect(mocks.shopSettings.update).not.toHaveBeenCalled();
    expect(result).toEqual({ aiResponseDelayMinutes: 5, updatedAt });
  });

  it("rejects stale revisions without writing", async () => {
    await expect(
      saveAiResponseDelay(shopId, "7", "2026-10-30T10:00:00.000Z", mocks.client as never),
    ).rejects.toThrow("CONFLICT");
    expect(mocks.shopSettings.update).not.toHaveBeenCalled();
  });

  it("rejects missing shop settings without writing", async () => {
    mocks.shopSettings.findUnique.mockResolvedValue(null);
    await expect(
      saveAiResponseDelay(shopId, "7", updatedAt.toISOString(), mocks.client as never),
    ).rejects.toThrow("DENIED");
    expect(mocks.shopSettings.update).not.toHaveBeenCalled();
  });
});
