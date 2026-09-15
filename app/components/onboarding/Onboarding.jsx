// @ts-nocheck

import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";
import "./Onboarding.css";

function BenefitIcon({ children }) {
  return <div className="mi-benefit-icon" aria-hidden="true">{children}</div>;
}

BenefitIcon.propTypes = {
  children: PropTypes.node.isRequired,
};

function formatUsageEvent(event, i18n, t) {
  if (event.pricingMode === "FIXED") {
    return `${t("onboarding.pricing.fixed")}: ${i18n.formatMoney(event.fixedUnitAmountMinor / 100, event.currency)} / ${event.creditsGrantedPerUnit}`;
  }
  const tiers = event.tiers.map((tier) => {
    const upperBound = tier.upTo === null ? "∞" : tier.upTo;
    return `${upperBound}: ${i18n.formatMoney(tier.amountPerUnitMinor / 100, event.currency)}`;
  });
  return `${t(`onboarding.pricing.${event.pricingMode.toLowerCase()}`)}: ${tiers.join(" · ")}`;
}

export default function Onboarding({ merchantUi, pricingCatalogue }) {
  const i18n = createMerchantI18n(merchantUi);
  const t = (key) => i18n.t(key);
  const cataloguePlans = pricingCatalogue ?? [];
  const firstFreePlan = cataloguePlans.find((plan) => plan.planKind === "FREE");

  return (
    <s-page heading={t("onboarding.title")}>
      <div className="mi-onboarding">
          <section className="mi-cta" aria-labelledby="mi-cta-title">
          <div>
            <div className="mi-eyebrow mi-eyebrow-light">{t("onboarding.cta.eyebrow")}</div>
            <h2 id="mi-cta-title">{t("onboarding.cta.title")}</h2>
            <p>{t("onboarding.cta.description")}</p>
            <div className="mi-shopify-note">
              <span className="mi-lock" aria-hidden="true">✓</span>
              <span>{t("onboarding.cta.shopifyManaged")}</span>
            </div>
          </div>
          <s-button href="/app/billing/select" variant="primary">
            {t("onboarding.choosePlan")}
          </s-button>
        </section>

        <section className="mi-hero" aria-labelledby="mi-onboarding-hero-title">
          <div className="mi-hero-copy">
            <div className="mi-eyebrow">{t("onboarding.hero.eyebrow")}</div>
            <h1 id="mi-onboarding-hero-title" className="mi-hero-title">
              {t("onboarding.hero.title")}
            </h1>
            <p className="mi-hero-description">
              {t("onboarding.hero.description")}
            </p>

            <div className="mi-hero-actions">
              <s-button href="/app/billing/select" variant="primary">
                {t("onboarding.choosePlan")}
              </s-button>
              <a className="mi-text-link" href="#how-it-works">
                {t("onboarding.hero.howItWorks")}
              </a>
            </div>

            <div className="mi-proof-strip" role="list" aria-label={t("onboarding.hero.highlightsLabel")}>
              <div className="mi-proof-item" role="listitem">
                <strong>{firstFreePlan?.includedRecoveryCredits ?? "-"}</strong>
                <span>{t("onboarding.hero.freeConversations")}</span>
              </div>
              <div className="mi-proof-item" role="listitem">
                <strong>20</strong>
                <span>{t("onboarding.hero.languages")}</span>
              </div>
              <div className="mi-proof-item" role="listitem">
                <strong>WhatsApp</strong>
                <span>{t("onboarding.hero.noSeparateBilling")}</span>
              </div>
            </div>
          </div>

          <div className="mi-hero-visual" aria-hidden="true">
            <div className="mi-orbit mi-orbit-one" />
            <div className="mi-orbit mi-orbit-two" />
            <div className="mi-visual-core">
              <span>{t("onboarding.visual.abandoned")}</span>
              <strong>{t("onboarding.visual.recoveryConversation")}</strong>
              <small>{t("onboarding.visual.aiWhatsApp")}</small>
            </div>
            <div className="mi-visual-chip mi-chip-one">Shopify</div>
            <div className="mi-visual-chip mi-chip-two">WhatsApp</div>
            <div className="mi-visual-chip mi-chip-three">AI</div>
            <div className="mi-visual-chip mi-chip-four">{t("onboarding.visual.multilingual")}</div>
          </div>
        </section>

        <section className="mi-section" aria-labelledby="mi-benefits-title">
          <div className="mi-section-heading">
            <div className="mi-eyebrow">{t("onboarding.benefits.eyebrow")}</div>
            <h2 id="mi-benefits-title">{t("onboarding.benefits.title")}</h2>
            <p>{t("onboarding.benefits.description")}</p>
          </div>

          <div className="mi-benefit-grid">
            <article className="mi-benefit-card">
              <BenefitIcon>↗</BenefitIcon>
              <h3>{t("onboarding.benefits.recover.title")}</h3>
              <p>{t("onboarding.benefits.recover.description")}</p>
            </article>
            <article className="mi-benefit-card">
              <BenefitIcon>◎</BenefitIcon>
              <h3>{t("onboarding.benefits.conversation.title")}</h3>
              <p>{t("onboarding.benefits.conversation.description")}</p>
            </article>
            <article className="mi-benefit-card">
              <BenefitIcon>文</BenefitIcon>
              <h3>{t("onboarding.benefits.language.title")}</h3>
              <p>{t("onboarding.benefits.language.description")}</p>
            </article>
            <article className="mi-benefit-card">
              <BenefitIcon>£</BenefitIcon>
              <h3>{t("onboarding.benefits.pricing.title")}</h3>
              <p>{t("onboarding.benefits.pricing.description")}</p>
            </article>
          </div>
        </section>

        <section id="how-it-works" className="mi-section mi-how" aria-labelledby="mi-how-title">
          <div className="mi-section-heading">
            <div className="mi-eyebrow">{t("onboarding.how.eyebrow")}</div>
            <h2 id="mi-how-title">{t("onboarding.how.title")}</h2>
            <p>{t("onboarding.how.description")}</p>
          </div>

          <div className="mi-flow" role="list">
            <article className="mi-flow-step" role="listitem">
              <div className="mi-step-number">1</div>
              <h3>{t("onboarding.how.step1.title")}</h3>
              <p>{t("onboarding.how.step1.description")}</p>
            </article>
            <div className="mi-flow-arrow" aria-hidden="true">→</div>
            <article className="mi-flow-step" role="listitem">
              <div className="mi-step-number">2</div>
              <h3>{t("onboarding.how.step2.title")}</h3>
              <p>{t("onboarding.how.step2.description")}</p>
            </article>
            <div className="mi-flow-arrow" aria-hidden="true">→</div>
            <article className="mi-flow-step" role="listitem">
              <div className="mi-step-number">3</div>
              <h3>{t("onboarding.how.step3.title")}</h3>
              <p>{t("onboarding.how.step3.description")}</p>
            </article>
            <div className="mi-flow-arrow" aria-hidden="true">→</div>
            <article className="mi-flow-step" role="listitem">
              <div className="mi-step-number">4</div>
              <h3>{t("onboarding.how.step4.title")}</h3>
              <p>{t("onboarding.how.step4.description")}</p>
            </article>
          </div>
        </section>

        <section className="mi-section" aria-labelledby="mi-pricing-title">
          <div className="mi-section-heading">
            <div className="mi-eyebrow">{t("onboarding.pricing.eyebrow")}</div>
            <h2 id="mi-pricing-title">{t("onboarding.pricing.title")}</h2>
            <p>{t("onboarding.pricing.description")}</p>
          </div>

          <div className="mi-plan-grid">
            {cataloguePlans.length === 0 && <p className="mi-pricing-unavailable">{t("onboarding.pricing.unavailable")}</p>}
            {cataloguePlans.map((plan) => (
              <article
                className={`mi-plan-card${plan.featured ? " mi-plan-card-featured" : ""}`}
                key={plan.id}
              >
                {plan.featured && (
                  <div className="mi-plan-badge">{t("onboarding.pricing.mostPopular")}</div>
                )}
                <div className="mi-plan-name">{plan.name}</div>
                <div className="mi-plan-price">
                  {i18n.formatMoney(plan.recurringAmountMinor / 100, plan.currency)}
                  {plan.billingPeriod === "EVERY_30_DAYS" && <span>{t("onboarding.pricing.perMonth")}</span>}
                </div>
                <p className="mi-plan-description">{plan.localizedDescription}</p>

                <div className="mi-plan-allowance">
                  <strong>{plan.includedRecoveryCredits}</strong>
                  <span>{t(plan.allowancePeriod === "LIFETIME" ? "onboarding.pricing.free.allowance" : "onboarding.pricing.monthlyAllowance")}</span>
                </div>

                {plan.usageEvents.map((event) => (
                  <div className="mi-plan-topup" key={event.eventHandle}>
                    <span>{t("onboarding.pricing.topupLabel")}</span>
                    <strong>{formatUsageEvent(event, i18n, t)}</strong>
                  </div>
                ))}
              </article>
            ))}
          </div>

          <div className="mi-shared-features">
            <strong>{t("onboarding.pricing.sameProduct.title")}</strong>
            <span>{t("onboarding.pricing.sameProduct.description")}</span>
          </div>
        </section>

        <section className="mi-section mi-topups" aria-labelledby="mi-topups-title">
          <div className="mi-section-heading">
            <div className="mi-eyebrow">{t("onboarding.topups.eyebrow")}</div>
            <h2 id="mi-topups-title">{t("onboarding.topups.title")}</h2>
            <p>{t("onboarding.topups.description")}</p>
          </div>

          <div className="mi-topup-layout">
            <div className="mi-topup-explainer">
              <div className="mi-topup-stat">
                <span>{t("onboarding.topups.nonExpiringLabel")}</span>
                <strong>{t("onboarding.topups.nonExpiringValue")}</strong>
              </div>
              <div className="mi-topup-stat">
                <span>{t("onboarding.topups.subscriberValueLabel")}</span>
                <strong>{t("onboarding.topups.subscriberValueValue")}</strong>
              </div>
              <p>{t("onboarding.topups.explainer")}</p>
            </div>

            <div className="mi-topup-ladder" aria-label={t("onboarding.topups.ladderLabel")}>
              {cataloguePlans.flatMap((plan) => plan.usageEvents.map((event) => (
                <article className="mi-topup-row" key={`${plan.shopifyPlanHandle}-${event.eventHandle}`}>
                  <div className="mi-topup-amount">{plan.displayName}</div>
                  <div className="mi-topup-values"><div><span>{event.eventHandle}</span><strong>{formatUsageEvent(event, i18n, t)}</strong></div></div>
                </article>
              )))}
              <div className="mi-topup-caption">{t("onboarding.topups.caption")}</div>
            </div>
          </div>
        </section>


      </div>
    </s-page>
  );
}

Onboarding.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  pricingCatalogue: PropTypes.arrayOf(PropTypes.shape({
    shopifyPlanHandle: PropTypes.string.isRequired,
    displayName: PropTypes.string.isRequired,
    planKind: PropTypes.string.isRequired,
    cataloguePosition: PropTypes.number.isRequired,
    featured: PropTypes.bool.isRequired,
    localizedDescription: PropTypes.string.isRequired,
    includedRecoveryCredits: PropTypes.number.isRequired,
    allowancePeriod: PropTypes.string.isRequired,
    billingPeriod: PropTypes.string.isRequired,
    recurringAmountMinor: PropTypes.number.isRequired,
    currency: PropTypes.string.isRequired,
    usageEvents: PropTypes.array.isRequired,
  })),
};
