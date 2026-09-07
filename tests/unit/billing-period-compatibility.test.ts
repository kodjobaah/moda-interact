import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const consumerFiles = [
  "app/routes/app._index.jsx",
  "app/routes/app.usage.jsx",
  "app/components/dashboard/UsageOverview.jsx",
  "app/components/dashboard/UsageEvents.jsx",
];

describe("BillingPeriod status compatibility", () => {
  it("uses CLOSED for historical periods in every known merchant consumer", () => {
    for (const relativePath of consumerFiles) {
      const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");

      expect(source).toContain('status === "CLOSED"');
      expect(source).not.toContain('status === "PAID"');
    }
  });
});