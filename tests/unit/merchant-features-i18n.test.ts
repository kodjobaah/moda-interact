import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
it("all supported locales include every feature, pending, denial and reconciliation label", () => {
  const dir = "app/i18n/locales";
  const en = JSON.parse(readFileSync(`${dir}/en.json`, "utf8"));
  const keys = Object.keys(en).filter((k) => k.startsWith("merchantFeatures."));
  expect(keys).toHaveLength(16);
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
    expect(
      Object.keys(data)
        .filter((k) => k.startsWith("merchantFeatures."))
        .sort(),
    ).toEqual(keys.sort());
    for (const key of keys) expect(data[key].trim().length).toBeGreaterThan(0);
  }
});
