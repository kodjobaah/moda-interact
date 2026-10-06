// @ts-nocheck

import React, { useEffect, useRef, useState } from "react";
import { useFetcher, useNavigate } from "react-router";
import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";
import MerchantPricingCatalogue from "../merchant-pricing/MerchantPricingCatalogue";
import "./Onboarding.css";

void React;

function BenefitIcon({ children }) {
  return <div className="mi-benefit-icon" aria-hidden="true">{children}</div>;
}

BenefitIcon.propTypes = {
  children: PropTypes.node.isRequired,
};

export default function Onboarding({
  merchantUi,
  pricingCatalogue,
  storeCategories = [],
  pendingCategoryId,
  pendingSelectionGeneration = 0,
  suggestedCategoryId,
  resumeExistingSubscription = false,
}) {
  const i18n = createMerchantI18n(merchantUi);
  const t = (key, values) => i18n.t(key, values);
  const cataloguePlans = pricingCatalogue ?? [];
  const firstFreePlan = cataloguePlans.find((plan) => plan.planKind === "FREE");
  const initialCategoryId = storeCategories.some((category) => category.id === pendingCategoryId)
    ? pendingCategoryId
    : storeCategories.some((category) => category.id === suggestedCategoryId)
      ? suggestedCategoryId
      : storeCategories[0]?.id ?? "";
  const [selectedCategoryId, setSelectedCategoryId] = useState(initialCategoryId);
  const [currentGeneration, setCurrentGeneration] = useState(pendingSelectionGeneration);
  const categoryFetcher = useFetcher();
  const resumeFetcher = useFetcher();
  const navigate = useNavigate();
  const resumeRequestedGeneration = useRef(null);
  const categorySaving = categoryFetcher.state !== "idle" || resumeFetcher.state !== "idle";
  const categoryError = categoryFetcher.data?.error ?? resumeFetcher.data?.error;

  useEffect(() => {
    if (
      !resumeExistingSubscription ||
      !pendingCategoryId ||
      !Number.isSafeInteger(currentGeneration) ||
      currentGeneration < 0 ||
      categoryFetcher.state !== "idle" ||
      resumeFetcher.state !== "idle" ||
      resumeFetcher.data?.ok ||
      resumeRequestedGeneration.current === currentGeneration
    ) return;

    resumeRequestedGeneration.current = currentGeneration;
    resumeFetcher.submit({
      expectedPendingSelectionGeneration: String(currentGeneration),
    }, { method: "post", action: "/app/onboarding/resume" });
  }, [
    categoryFetcher.state,
    currentGeneration,
    pendingCategoryId,
    resumeExistingSubscription,
    resumeFetcher,
    resumeFetcher.data,
    resumeFetcher.state,
  ]);

  useEffect(() => {
    if (!categoryFetcher.data?.ok) return;
    const nextGeneration = categoryFetcher.data.pendingSelectionGeneration;
    if (Number.isSafeInteger(nextGeneration)) setCurrentGeneration(nextGeneration);

    if (!resumeExistingSubscription) {
      navigate("/app/billing/select");
      return;
    }

    if (resumeRequestedGeneration.current === nextGeneration) return;
    resumeRequestedGeneration.current = nextGeneration;
    resumeFetcher.submit({
      expectedPendingSelectionGeneration: String(nextGeneration),
    }, { method: "post", action: "/app/onboarding/resume" });
  }, [categoryFetcher.data, navigate, resumeExistingSubscription, resumeFetcher]);

  useEffect(() => {
    if (resumeFetcher.data?.ok) navigate("/app");
  }, [resumeFetcher.data, navigate]);

  const choosePlan = () => {
    if (!selectedCategoryId || categorySaving) return;
    categoryFetcher.submit({
      categoryId: selectedCategoryId,
      expectedPendingSelectionGeneration: String(currentGeneration),
    }, { method: "post", action: "/app/store-profile/category" });
  };

  return (
    <s-page heading={t("onboarding.title")}>
      <div className="mi-onboarding">
          <section className="mi-cta" aria-labelledby="mi-cta-title">
          <div>
            <div className="mi-eyebrow mi-eyebrow-light">{t("onboarding.cta.eyebrow")}</div>
            <h2 id="mi-cta-title">{t("onboarding.cta.title")}</h2>
            <p>
              <span className="mi-cta-link">
                {t("onboarding.cta.description")}
              </span>
            </p>
            <label className="mi-store-category-control" htmlFor="onboarding-store-category">
              <span>{t("storeProfile.categoryLabel")}</span>
              <select
                id="onboarding-store-category"
                value={selectedCategoryId}
                onChange={(event) => setSelectedCategoryId(event.currentTarget.value)}
                disabled={!storeCategories.length || categorySaving}
              >
                {storeCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.localizedDisplayName}
                  </option>
                ))}
              </select>
              {storeCategories.find((category) => category.id === selectedCategoryId)?.localizedDescription ? (
                <small>{storeCategories.find((category) => category.id === selectedCategoryId).localizedDescription}</small>
              ) : null}
            </label>
            {!storeCategories.length ? (
              <p role="status">{t("storeProfile.configurationUnavailable")}</p>
            ) : null}
            {categoryError ? (
              <p role="alert">{t(categoryError === "CONFLICT" ? "storeProfile.selectionConflict" : "storeProfile.saveFailed")}</p>
            ) : null}
            <div className="mi-shopify-note">
              <span className="mi-lock" aria-hidden="true">✓</span>
              <span>{t("onboarding.cta.shopifyManaged")}</span>
            </div>
          </div>
          <s-button onClick={choosePlan} disabled={!storeCategories.length || categorySaving || !selectedCategoryId} variant="primary">
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
              <s-button onClick={choosePlan} disabled={!storeCategories.length || categorySaving || !selectedCategoryId} variant="primary">
                {t("onboarding.choosePlan")}
              </s-button>
              <a className="mi-text-link" href="#how-it-works">
                {t("onboarding.hero.howItWorks")}
              </a>
            </div>

            <div className="mi-proof-strip" role="list" aria-label={t("onboarding.hero.highlightsLabel")}>
              {firstFreePlan && (
                <div className="mi-proof-item" role="listitem">
                  <strong>{firstFreePlan.includedRecoveryCredits}</strong>
                  <span>{t("onboarding.hero.freeConversations")}</span>
                </div>
              )}
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

          <MerchantPricingCatalogue merchantUi={merchantUi} pricingCatalogue={cataloguePlans} showChoosePlanAction={false} />

          <div className="mi-shared-features">
            <strong>{t("onboarding.pricing.sameProduct.title")}</strong>
            <span>{t("onboarding.pricing.sameProduct.description")}</span>
          </div>
        </section>

      </div>
    </s-page>
  );
}

Onboarding.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  storeCategories: PropTypes.array,
  pendingCategoryId: PropTypes.string,
  pendingSelectionGeneration: PropTypes.number,
  suggestedCategoryId: PropTypes.string,
  resumeExistingSubscription: PropTypes.bool,
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
    highlights: PropTypes.array.isRequired,
  })),
};
