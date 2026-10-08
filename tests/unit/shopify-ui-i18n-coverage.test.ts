import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

const [appShellSource, supportRouteSource, navigationSource, routeConfigSource] = await Promise.all([
  readFile(new URL("../../app/routes/app/route.jsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/routes/app/merchant-support/route.jsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/components/dashboard/MerchantNavigation.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../app/routes.ts", import.meta.url), "utf8"),
]);

describe("authenticated Shopify UI internationalisation coverage", () => {
  it("localizes the shell and all scoped support controls through existing keys", () => {
    expect(appShellSource).toContain('alt={i18n.t("common.logoAlt")}');
    expect(appShellSource).toContain("merchantUi: merchantUiContext(shop, session)");
    expect(appShellSource).toContain("<MerchantNavigation");
    expect(appShellSource).toContain("<Outlet />");

    for (const key of [
      "support.thread",
      "support.empty",
      "support.paginationLabel",
      "support.previous",
      "support.next",
      "support.contactHeading",
      "support.messageLabel",
      "support.sending",
      "support.send",
      "support.you",
      "support.system",
      "support.modaSupport",
      "support.translationUnavailable",
      "support.translationProcessing",
      "support.viewTranslation",
      "support.viewOriginal",
      "support.sendFailed",
      "support.unsupportedAction",
    ]) {
      expect(supportRouteSource).toContain(`i18n.t("${key}")`);
    }
    expect(supportRouteSource).toContain('i18n.t("support.page", { page: support.page, totalPages: support.totalPages })');
    expect(supportRouteSource).toContain('i18n.t("support.messageLengthError", { max: 500 })');
    expect(supportRouteSource).toContain('<s-page heading={i18n.t("merchantNav.support")}>');
    expect(supportRouteSource).toContain('<p dir="auto">');
    expect(navigationSource).toContain('support: "merchantNav.support"');
    expect(routeConfigSource).toContain('route("merchant-support", "./routes/app/merchant-support/route.jsx")');
  });

  it("keeps the scoped routes free of the retired merchant-facing English literals", () => {
    for (const literal of [
      "Moda Interact logo",
      "Support thread",
      "No messages yet.",
      "Support thread pages",
      "Previous",
      "Next",
      "Page {page} of {totalPages}",
      "Contact Moda Support",
      "Message",
      "Message must contain between 1 and 500 graphemes.",
      "Sending...",
      "Send",
      "You",
      "System",
      "Moda Support",
      "Translation unavailable. Please try again later.",
      "Translation is processing.",
      "View translation",
      "View original",
      "Unable to send message. Please try again.",
      "That support action is not available.",
      "Unsupported merchant support action.",
    ]) {
      expect(appShellSource).not.toContain(`"${literal}"`);
      expect(appShellSource).not.toContain(`>${literal}<`);
      expect(supportRouteSource).not.toContain(`"${literal}"`);
      expect(supportRouteSource).not.toContain(`>${literal}<`);
    }
    expect(supportRouteSource).not.toContain("error.message");
  });
});