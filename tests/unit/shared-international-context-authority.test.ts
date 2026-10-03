import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appRoot = fileURLToPath(new URL("../../app/", import.meta.url));
const contextField = "(?:defaultLanguageTag|defaultTimeZone|defaultCountryCode)";
const legacyContextRead = new RegExp(
  `(?:\\bsettings\\s*(?:\\?\\.)?\\s*\\.${contextField}\\b|shopSettings\\.(?:findUnique|findFirst|findMany)\\s*\\([\\s\\S]{0,500}?select\\s*:\\s*\\{[\\s\\S]{0,200}?\\b${contextField}\\b|SELECT\\s+"${contextField}"[\\s\\S]{0,200}?FROM\\s+"shopify"\\."ShopSettings")`,
  "i",
);

function productionSources(directory = appRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionSources(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

describe("shared international-context authority", () => {
  it("does not read merchant language, timezone, or country from ShopSettings", () => {
    const offenders = productionSources().filter((path) =>
      legacyContextRead.test(readFileSync(path, "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("writes shared context and compatibility mirrors in one provisioning transaction", () => {
    const provisioning = readFileSync(
      new URL("../../app/services/shop/shop.service.ts", import.meta.url),
      "utf8",
    );

    expect(provisioning).toMatch(
      /return prisma\.\$transaction\(async \(transaction\) => \{[\s\S]*transaction\.shop\.upsert\([\s\S]*transaction\.shopSettings\.upsert\(/,
    );
    expect(provisioning).toContain("storeLocale");
    expect(provisioning).toMatch(
      /transaction\.shopSettings\.upsert\([\s\S]{0,500}defaultLanguageTag[\s\S]*defaultTimeZone[\s\S]*defaultCountryCode/,
    );
  });
});
