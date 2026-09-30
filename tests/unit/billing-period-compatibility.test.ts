import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const consumerFiles = ["app/services/usage/history.server.ts"];

describe("BillingPeriod status compatibility", () => {
  it("uses CLOSED for historical periods in every known merchant consumer", () => {
    for (const relativePath of consumerFiles) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");

      expect(source).toContain('"CLOSED"');
      expect(source).not.toContain('"PAID"');
    }
  });
});