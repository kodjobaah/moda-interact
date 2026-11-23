import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  configureShopifyCheckoutReceiptOrigin,
  loadShopifyPlatformEnvironment,
} from "./shopify-dev-settings.mjs";

function withAppRoot(run) {
  const appRoot = mkdtempSync(join(tmpdir(), "moda-shopify-dev-"));
  try { run(appRoot); } finally { rmSync(appRoot, { recursive: true, force: true }); }
}

test("loads local platform.env and overrides stale shell settings without printing secrets", () => withAppRoot((appRoot) => {
  writeFileSync(join(appRoot, "platform.env"),
    `MODA_ENCRYPTION_KEYS_JSON='{"config-key-2026":"placeholder"}'\nMODA_ENCRYPTION_ACTIVE_KEY_ID=config-key-2026\n`);
  const environment = { MODA_ENCRYPTION_ACTIVE_KEY_ID: "stale-key" };
  assert.equal(loadShopifyPlatformEnvironment({ appRoot, environment }), true);
  assert.equal(environment.MODA_ENCRYPTION_ACTIVE_KEY_ID, "config-key-2026");
  assert.match(environment.MODA_ENCRYPTION_KEYS_JSON, /config-key-2026/);
}));

test("updates only receipt URL in Shopify config env file and passes same origin to CLI", () => withAppRoot((appRoot) => {
  const envFile = join(appRoot, ".env.moda-interact");
  writeFileSync(envFile, "SHOPIFY_APP_ID=keep-me\nMODA_CHECKOUT_RECEIPT_ORIGIN=https://old.example\n");
  const environment = {};
  const result = configureShopifyCheckoutReceiptOrigin("https://abc.ngrok-free.app", {appRoot, environment});
  assert.equal(result.origin, "https://abc.ngrok-free.app");
  assert.equal(environment.MODA_CHECKOUT_RECEIPT_ORIGIN, result.origin);
  assert.equal(readFileSync(envFile, "utf8"),
    "SHOPIFY_APP_ID=keep-me\nMODA_CHECKOUT_RECEIPT_ORIGIN=https://abc.ngrok-free.app\n");
  configureShopifyCheckoutReceiptOrigin("https://abc.ngrok-free.app", {appRoot, environment});
  assert.equal(readFileSync(envFile, "utf8").split("MODA_CHECKOUT_RECEIPT_ORIGIN").length, 2);
}));

test("creates .env.moda-interact with the public URL but no platform credentials", () => withAppRoot((appRoot) => {
  configureShopifyCheckoutReceiptOrigin("https://new.trycloudflare.com", {appRoot, environment: {}});
  assert.equal(readFileSync(join(appRoot, ".env.moda-interact"), "utf8"),
    "MODA_CHECKOUT_RECEIPT_ORIGIN=https://new.trycloudflare.com\n");
}));

test("rejects non-HTTPS or path-bearing origins", () => withAppRoot((appRoot) => {
  for (const url of ["http://localhost:50620", "https://foo.example/path", "not-a-url", "https://foo.example?secret=1"]) {
    assert.throws(() => configureShopifyCheckoutReceiptOrigin(url, {appRoot, environment: {}}));
  }
}));

test("refuses duplicate origin overrides rather than leaving ambiguous build input", () => withAppRoot((appRoot) => {
  writeFileSync(join(appRoot, ".env.moda-interact"),
    "MODA_CHECKOUT_RECEIPT_ORIGIN=https://one.example\nMODA_CHECKOUT_RECEIPT_ORIGIN=https://two.example\n");
  assert.throws(() => configureShopifyCheckoutReceiptOrigin("https://three.example", {appRoot, environment: {}}), /Duplicate/);
}));
