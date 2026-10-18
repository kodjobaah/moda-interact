import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const folder = resolve(process.cwd(), "app/services/platform-configuration");

describe("Shopify platform configuration is a server-only capability", () => {
  it("keeps secrets in .server modules with no existing runtime call-site edits", () => {
    for (const name of ["composition", "service", "repository", "seal", "contracts", "merchant-knowledge-r2", "shopify-oauth-credentials", "shopify-partner-credentials"]) {
      expect(readFileSync(resolve(folder, `${name}.server.ts`), "utf8").length).toBeGreaterThan(50);
    }
    const composition = readFileSync(resolve(folder, "composition.server.ts"), "utf8");
    expect(composition).toContain('"@modainteract/moda-interact-shared/security/credentials/node"');
    expect(composition).not.toMatch(/import\s*\{[^}]*\}\s*from\s*["'].*shopify\.server/);
    const service = readFileSync(resolve(folder, "service.server.ts"), "utf8");
    expect(service).not.toContain("process.env.SHOPIFY_API_SECRET");
    expect(service).not.toContain("process.env.MERCHANT_KNOWLEDGE_R2_");
    expect(service).not.toContain("new PrismaClient(");
  });
});
