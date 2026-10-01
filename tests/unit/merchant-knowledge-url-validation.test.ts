import { expect, it, vi } from "vitest";

vi.mock("../../app/db.server", () => ({ default: {} }));

import {
  createWebPageSource,
  MerchantKnowledgeError,
} from "../../app/services/merchant-knowledge/merchant-knowledge.server";

const database = {
  $transaction: vi.fn(),
} as unknown as NonNullable<Parameters<typeof createWebPageSource>[0]["database"]>;

it.each([
  "http://example.test/page",
  "https://user:password@example.test/page",
  "https://[broken",
  `https://example.test/${"a".repeat(2040)}`,
])("rejects a non-public-HTTPS URL before opening a database transaction", async (url) => {
  await expect(createWebPageSource({
    shopId: "shop-1",
    name: "Page",
    purposeKey: "FAQ",
    dataFormatKey: "WEB_PAGE",
    url,
    database,
  })).rejects.toMatchObject({
    name: "MerchantKnowledgeError",
    code: "INVALID_INPUT",
  } satisfies Partial<MerchantKnowledgeError>);

  expect(database.$transaction).not.toHaveBeenCalled();
});

it("rejects a canonical URL longer than 2048 characters before opening a transaction", async () => {
  const url = `https://example.test/${"é".repeat(400)}`;
  expect(url.length).toBeLessThan(2048);
  expect(new URL(url).toString().length).toBeGreaterThan(2048);

  await expect(createWebPageSource({
    shopId: "shop-1",
    name: "Page",
    purposeKey: "FAQ",
    dataFormatKey: "WEB_PAGE",
    url,
    database,
  })).rejects.toMatchObject({
    name: "MerchantKnowledgeError",
    code: "INVALID_INPUT",
  } satisfies Partial<MerchantKnowledgeError>);

  expect(database.$transaction).not.toHaveBeenCalled();
});