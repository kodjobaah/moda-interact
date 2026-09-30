import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

async function readRoute(route) {
  return readFile(resolve(repositoryRoot, "app/routes", route), "utf8");
}

describe("dashboard CheckoutRecovery conversation relation", () => {
  it("uses the singular Prisma relation while preserving the dashboard DTO", async () => {
    const source = await readRoute("app/home/route.jsx");
    const overviewSource = await readRoute("app/home/overview.server.ts");

    expect(source).toContain("loadOverviewPerformance");
    expect(overviewSource).toContain("readRecoveryOverview");
    expect(source).not.toMatch(/conversations:\s*\[\]/);
  });

  it("uses the singular relation for usage source resolution", async () => {
    const source = await readRoute("app/usage/route.jsx");
    const historySource = await readFile(
      resolve(repositoryRoot, "app/services/usage/history.server.ts"),
      "utf8",
    );

    expect(source).toContain("readUsageHistory(shop.id");
    expect(historySource).toContain("readUsageSources");
    expect(source).not.toMatch(/conversations:\s*\[\]/);
  });
});