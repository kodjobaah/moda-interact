import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
);
const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");

const { build, migrate, seed, start } = packageJson.scripts;

describe("deployment lifecycle command contract", () => {
  it("exposes the four distinguishable lifecycle phases", () => {
    for (const phase of ["build", "migrate", "seed", "start"]) {
      expect(packageJson.scripts[phase], phase).toBeTruthy();
    }
  });

  it("starts only the web runtime and never runs migration or seed", () => {
    expect(start).toContain("react-router-serve");
    expect(start).not.toMatch(/(docker-start|\bsetup\b|migrate|seed)/i);
  });

  it("runs migration as an independently callable command that does not seed", () => {
    expect(migrate).toMatch(/migrate deploy|prisma:migrate:deploy/);
    expect(migrate).not.toMatch(/seed/i);
    expect(migrate).not.toMatch(/react-router-serve/);
  });

  it("runs seed as an explicit command that does not migrate or start", () => {
    expect(seed).not.toMatch(/(migrate|deploy|react-router-serve)/i);
  });

  it("does not expose a combined start script that chains migration or seed", () => {
    expect(packageJson.scripts["docker-start"]).toBeUndefined();
    expect(packageJson.scripts.setup).toBeUndefined();
  });

  it("starts the Docker container with the web runtime only", () => {
    const cmd = dockerfile.match(/CMD\s+\[([^\]]*)\]/)?.[1] ?? "";
    expect(cmd).toContain("npm");
    expect(cmd).toContain("start");
    expect(cmd).not.toMatch(/(docker-start|setup|migrate|seed)/i);
  });

  it("keeps lifecycle commands environment-neutral", () => {
    for (const script of [build, migrate, seed, start]) {
      expect(script).not.toMatch(/postgres(ql)?:\/\/|DATABASE_URL=/i);
    }
  });
});
