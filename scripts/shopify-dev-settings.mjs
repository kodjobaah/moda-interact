import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_ORIGIN_KEY = "MODA_CHECKOUT_RECEIPT_ORIGIN";

/**
 * Load the existing local platform credentials before Shopify starts its app
 * server. The file is never copied to a Shopify extension or printed. Explicit
 * environment paths are supported for developer worktrees.
 *
 * On a local launch, the platform.env values take precedence over stale shell
 * values (for example a keyring left over from a different worktree).
 */
export function loadShopifyPlatformEnvironment({
  appRoot = APP_ROOT,
  environment = process.env,
} = {}) {
  const explicitPath = environment.MODA_PLATFORM_ENV_FILE;
  const filePath = explicitPath ? resolve(explicitPath) : resolve(appRoot, "platform.env");
  if (!existsSync(filePath)) {
    if (explicitPath) throw new Error(`MODA_PLATFORM_ENV_FILE not found: ${filePath}`);
    return false;
  }

  const variables = parseEnv(readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(variables)) {
    // Never let the local file control Node's execution flags.
    if (key === "NODE_OPTIONS") continue;
    environment[key] = value;
  }
  return true;
}

/**
 * The app and its checkout UI extension must use exactly the same public
 * HTTPS origin. Shopify CLI's --tunnel-url gets a trailing *local* port, but
 * the extension's URL must not use that local port.
 *
 * Shopify's named config (shopify.app.moda-interact.toml) uses the matching
 * ignored .env.moda-interact file for build-time process.env substitution.
 * Preserve all other entries in the file, including Shopify-managed IDs.
 */
export function configureShopifyCheckoutReceiptOrigin(publicUrl, {
  appRoot = APP_ROOT,
  environment = process.env,
} = {}) {
  let url;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error("Shopify development tunnel must provide a valid HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("Shopify development tunnel must be a bare HTTPS origin.");
  }

  const origin = url.origin;
  environment[RECEIPT_ORIGIN_KEY] = origin;

  const envFile = resolve(appRoot, ".env.moda-interact");
  const previous = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const line = `${RECEIPT_ORIGIN_KEY}=${origin}`;
  const pattern = /^[ \t]*(?:export[ \t]+)?MODA_CHECKOUT_RECEIPT_ORIGIN[ \t]*=.*$/gm;
  const matches = previous.match(pattern) ?? [];
  if (matches.length > 1) {
    throw new Error(`Duplicate ${RECEIPT_ORIGIN_KEY} entries in .env.moda-interact.`);
  }
  const next = matches.length === 1
    ? previous.replace(pattern, line)
    : `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}${line}\n`;
  if (next !== previous) writeFileSync(envFile, next, { mode: 0o600 });
  return { origin, envFile };
}
