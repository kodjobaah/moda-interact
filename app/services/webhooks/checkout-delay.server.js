import process from "node:process";
import db from "../../db.server";

const DEFAULT_RECOVERY_DELAY_MINUTES = 30;

/**
 * Resolves the checkout recovery delay for a shop, reusing the
 * shop-configurable `ShopSettings.recoveryDelayMinutes` with an
 * environment-configured fallback. Shared by legacy and outbox dispatch so
 * behaviour stays identical across modes.
 *
 * @param {string} shopDomain
 */
export async function resolveCheckoutDelayMs(shopDomain) {
  const shopRecord = await db.shop.findUnique({
    where: { domain: shopDomain },
    select: {
      settings: {
        select: { recoveryDelayMinutes: true },
      },
    },
  });

  const configuredDelayMinutes = shopRecord?.settings?.recoveryDelayMinutes;

  const fallbackDelayMs = Number(
    process.env.CHECKOUT_RECOVERY_DELAY_MS ??
      DEFAULT_RECOVERY_DELAY_MINUTES * 60 * 1000,
  );

  const recoveryDelayMs =
    configuredDelayMinutes == null
      ? fallbackDelayMs
      : configuredDelayMinutes * 60 * 1000;

  return Number.isFinite(recoveryDelayMs) && recoveryDelayMs >= 0
    ? recoveryDelayMs
    : DEFAULT_RECOVERY_DELAY_MINUTES * 60 * 1000;
}
