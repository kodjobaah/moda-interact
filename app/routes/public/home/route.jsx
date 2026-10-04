import { redirect, Form, useLoaderData } from "react-router";
import { login } from "@/shopify.server";
import MerchantPricingCatalogue from "@/components/merchant-pricing/MerchantPricingCatalogue";
import { readActiveMerchantPricingCatalogue } from "@/services/merchant-pricing/merchant-pricing.server";
import styles from "./styles.module.css";

const MYSHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

function requestLocale(request) {
  const accepted = request.headers.get("accept-language")?.split(",")[0]?.split(";")[0]?.trim();
  return accepted || "en-GB";
}

function detectedShopFromUrl(url) {
  const raw = url.searchParams.get("shop")?.trim().toLowerCase() ?? "";
  return MYSHOPIFY_DOMAIN.test(raw) ? raw : null;
}

function hasEmbeddedHint(url) {
  return url.searchParams.get("embedded") === "1" || Boolean(url.searchParams.get("host"));
}

/** @param {{ request: Request }} args */
export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const detectedShop = detectedShopFromUrl(url);
  const embedded = hasEmbeddedHint(url);

  // Preserve the existing direct-shop navigation behaviour outside the embedded
  // install/connect surface. Shopify embedded launches carry host/embedded hints.
  if (detectedShop && !embedded) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  const locale = requestLocale(request);
  const pricingCatalogue = (await readActiveMerchantPricingCatalogue({ locale })).map((plan) => ({
    cataloguePosition: plan.cataloguePosition,
    displayName: plan.displayName,
    planKind: plan.planKind,
    featured: plan.featured,
    localizedDescription: plan.localizedDescription,
    includedRecoveryCredits: plan.includedRecoveryCredits,
    allowancePeriod: plan.allowancePeriod,
    billingPeriod: plan.billingPeriod,
    recurringAmountMinor: plan.recurringAmountMinor,
    currency: plan.currency,
    highlights: plan.highlights,
  }));

  return {
    showForm: Boolean(login),
    detectedShop: embedded ? detectedShop : null,
    merchantUi: {
      locale,
      timeZone: "UTC",
      fallbackLocale: "en-GB",
    },
    pricingCatalogue,
  };
};

export default function App() {
  const { showForm, detectedShop, merchantUi, pricingCatalogue } = useLoaderData();
  const hasDetectedShop = Boolean(detectedShop);

  return (
    <div className={`${styles.page} bg-forest-50 text-forest-900`}>
      <main className={`${styles.shell} font-display`}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <div className="brand-lockup text-forest-900">
              <img className="brand-mark" src="/images/moda-interact-logo.jpg" alt="Moda Interact logo" />
              <span>Moda Interact</span>
            </div>

            <p className={styles.eyebrow}>Shopify recovery, powered by Moda Interact</p>
            <h1 className={`${styles.heading} text-forest-950`}>
              Recover abandoned checkouts with personalised, AI-assisted conversations.
            </h1>
            <p className={styles.text}>
              Reconnect with customers who leave before completing their purchase, automate
              thoughtful follow-up, and understand the revenue your recoveries bring back.
            </p>

            <a
              className={styles.websiteLink}
              href="https://www.modainteract.com/"
              target="_blank"
              rel="noreferrer"
            >
              Learn more about Moda Interact <span aria-hidden="true">↗</span>
            </a>
          </div>

          <section className={styles.connectionCard} aria-labelledby="connection-title">
            <span className={styles.connectionPill}>Shopify connection</span>
            <h2 id="connection-title">
              {hasDetectedShop ? "Connect this Shopify store" : "Connect your Shopify store"}
            </h2>
            <p className={styles.connectionText}>
              {hasDetectedShop
                ? "We detected the store that opened Moda Interact. Confirm to continue securely."
                : "Enter your .myshopify.com domain to begin the secure Shopify connection flow."}
            </p>

            {showForm && (
              <Form className={styles.form} method="post" action="/auth/login">
                {hasDetectedShop ? (
                  <>
                    <div className={styles.detectedStore}>
                      <span className={styles.storeStatus} aria-hidden="true" />
                      <div>
                        <span className={styles.storeLabel}>Shopify store</span>
                        <strong>{detectedShop}</strong>
                      </div>
                    </div>
                    <input type="hidden" name="shop" value={detectedShop} />
                  </>
                ) : (
                  <label className={styles.label}>
                    <span>Shop domain</span>
                    <input
                      className={styles.input}
                      type="text"
                      name="shop"
                      placeholder="your-store.myshopify.com"
                      autoComplete="url"
                      required
                    />
                    <small>For example: your-store.myshopify.com</small>
                  </label>
                )}

                <button className={`${styles.button} bg-forest-800 text-white`} type="submit">
                  {hasDetectedShop ? "Connect this store" : "Connect your Shopify store"}
                </button>
              </Form>
            )}

            <p className={styles.reassurance}>
              Takes less than a minute. You can disconnect Moda Interact from Shopify at any time.
            </p>
          </section>
        </section>

        <section className={styles.benefits} aria-labelledby="benefits-title">
          <div className={styles.sectionHeading}>
            <span className={styles.sectionEyebrow}>What Moda Interact can do</span>
            <h2 id="benefits-title">Turn more abandoned checkouts into customer conversations.</h2>
          </div>

          <div className={styles.benefitGrid}>
            <article className={styles.benefitCard}>
              <span className={styles.benefitNumber}>01</span>
              <h3>Recover abandoned checkouts</h3>
              <p>Identify recoverable checkouts and start a recovery journey automatically.</p>
            </article>
            <article className={styles.benefitCard}>
              <span className={styles.benefitNumber}>02</span>
              <h3>Personalised conversations</h3>
              <p>Use intelligent timing and AI-assisted follow-up tailored to customer behaviour.</p>
            </article>
            <article className={styles.benefitCard}>
              <span className={styles.benefitNumber}>03</span>
              <h3>Measure recovered revenue</h3>
              <p>See recoveries, conversion performance, and the revenue returned to your store.</p>
            </article>
          </div>
        </section>

        <section className={styles.pricingSection} aria-labelledby="pricing-title">
          <div className={styles.sectionHeading}>
            <span className={styles.sectionEyebrow}>Plans</span>
            <h2 id="pricing-title">Choose the level that fits your store.</h2>
            <p>
              Preview the current Moda Interact merchant catalogue now. You will choose and confirm
              an eligible plan after your Shopify store is connected.
            </p>
          </div>

          <MerchantPricingCatalogue
            merchantUi={merchantUi}
            pricingCatalogue={pricingCatalogue}
            showChoosePlanAction={false}
          />

          <p className={styles.pricingNote}>
            Pricing shown here comes from the active Moda Interact merchant catalogue. Shopify
            billing is confirmed only after your store has been securely connected.
          </p>
        </section>
      </main>
    </div>
  );
}
