import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const keys = [
  "recoverySettings.adminOverride", "recoverySettings.aiDescription", "recoverySettings.discount.code",
  "recoverySettings.discount.endsAt", "recoverySettings.discount.method", "recoverySettings.discount.method.AUTOMATIC",
  "recoverySettings.discount.method.CODE", "recoverySettings.discount.startsAt", "recoverySettings.discount.status",
  "recoverySettings.discount.status.ACTIVE", "recoverySettings.discount.summary", "recoverySettings.effective",
  "recoverySettings.effectiveFixedDiscount", "recoverySettings.effectiveFollowUpDisabled", "recoverySettings.effectiveFollowUpEnabled", "recoverySettings.effectiveOffer",
  "recoverySettings.followUp.creditWarning", "recoverySettings.followUp.delay", "recoverySettings.followUp.enable",
  "recoverySettings.followUp.title", "recoverySettings.invalid", "recoverySettings.offer.AI_BEST_APPLICABLE",
  "recoverySettings.offer.FIXED", "recoverySettings.offer.NONE", "recoverySettings.offer.catalogueUnavailable",
  "recoverySettings.offer.notSelectable", "recoverySettings.offer.title", "recoverySettings.save", "recoverySettings.saved",
  "recoverySettings.start.label", "recoverySettings.start.title", "recoverySettings.title", "recoverySettings.nav",
].sort();

describe("Recovery Settings translation contract", () => {
  it("contains the exact handoff namespace in every locale", () => {
    for (const locale of ["cs", "da", "de", "en", "es", "fi", "fr", "it", "ja", "ko", "nb", "nl", "pl", "pt-BR", "pt-PT", "sv", "th", "tr", "zh-Hans", "zh-Hant"]) {
      const catalogue = JSON.parse(fs.readFileSync(path.resolve(root, `app/i18n/locales/${locale}.json`), "utf8"));
      expect(Object.keys(catalogue).filter((key) => key.startsWith("recoverySettings.")).sort()).toEqual(keys);
      for (const key of keys) expect(typeof catalogue[key]).toBe("string");
    }
  });

  it("uses the supplied date/fact and effective identity keys", () => {
    const route = fs.readFileSync(path.resolve(root, "app/routes/app/recovery-settings/route.tsx"), "utf8");
    expect(route).toContain("recoverySettings.discount.startsAt");
    expect(route).toContain("recoverySettings.discount.endsAt");
    expect(route).not.toContain("recoverySettings.discount.starts\"");
    expect(route).toContain("recoverySettings.discount.summary");
    expect(route).toContain("recoverySettings.effectiveFixedDiscount");
  });
});