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
    const source = await readRoute("app._index.jsx");

    expect(source).toMatch(/conversation: \{ include: \{ messages: true \} \}/);
    expect(source).not.toMatch(/conversations: \{\s*include:/);
    expect(source).toMatch(/recovery\.conversation/);
    expect(source).not.toMatch(/recovery\.conversations\[0\]/);
    expect(source).toMatch(/conversations: conversation \?/);
    expect(source).toMatch(/conversation\?\.messages\.length \?\?/);
  });

  it("uses the singular relation for usage source resolution", async () => {
    const source = await readRoute("app.usage.jsx");

    expect(source).toMatch(
      /conversation: \{ include: \{ messages: \{ select: \{ id: true \} \} \} \}/,
    );
    expect(source).not.toMatch(/conversations: \{\s*include:/);
    expect(source).toMatch(/const conversation = recovery\.conversation;/);
    expect(source).not.toMatch(/recovery\.conversations\[0\]/);
    expect(source).toMatch(/recoveryBySourceId\.set\(message\.id/);
  });
});