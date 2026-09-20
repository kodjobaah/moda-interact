import { useState } from "react";
import type { loader } from "./route";
import Breadcrumbs from "@/components/dashboard/Breadcrumbs";
import { createMerchantI18n } from "@/utils/merchant-i18n";
import SettingsForm from "@/components/settings/SettingsForm";
import FeaturePreferences from "@/components/settings/FeaturePreferences";
import "./RecoverySettingsRoute.css";
type DiscountRow = Awaited<ReturnType<typeof loader>>["discounts"][number];
type DiscountCatalogueStatus = Awaited<
  ReturnType<typeof loader>
>["catalogueStatus"];
type RecoveryOfferMode = "NONE" | "FIXED" | "AI_BEST_APPLICABLE";

function discountCatalogueMessageKey(status: DiscountCatalogueStatus) {
  switch (status) {
    case "CURRENT":
      return "recoverySettings.offer.catalogueEmpty";
    case "SYNC_REQUIRED":
      return "recoverySettings.offer.catalogueSyncRequired";
    case "SYNCING":
      return "recoverySettings.offer.catalogueSyncing";
    case "ERROR":
      return "recoverySettings.offer.catalogueError";
    default:
      return "recoverySettings.offer.catalogueUnavailable";
  }
}

export default function RecoverySettingsView({
  data,
}: {
  data: Awaited<ReturnType<typeof loader>>;
}) {
  const i18n = createMerchantI18n(data.merchantUi);
  const effective = data.effective;
  const [selectedOfferMode, setSelectedOfferMode] = useState<RecoveryOfferMode>(
    data.merchant.recoveryOfferMode,
  );
  const [selectedFixedDiscountId, setSelectedFixedDiscountId] = useState(
    data.merchant.fixedShopifyDiscountId ?? "",
  );
  const [followUpEnabled, setFollowUpEnabled] = useState(
    data.merchant.followUpEnabled,
  );

  return (
    <s-page heading={i18n.t("recoverySettings.title")}>
      <Breadcrumbs
        items={[]}
        current={i18n.t("recoverySettings.title")}
        merchantUi={data.merchantUi}
      />
      <div className="moda-recovery-settings-page">
        <section className="moda-recovery-hero">
          <div className="moda-recovery-hero-copy">
            <span className="moda-recovery-eyebrow">
              {i18n.t("recoverySettings.nav")}
            </span>
            <h1>{i18n.t("recoverySettings.title")}</h1>
          </div>
          <div
            className="moda-recovery-effective-grid"
            aria-label={i18n.t("recoverySettings.title")}
          >
            <div className="moda-recovery-effective-card">
              <span>{i18n.t("recoverySettings.start.title")}</span>
              <strong>
                {i18n.t("recoverySettings.effective", {
                  value: effective.recoveryDelayMinutes,
                })}
              </strong>
            </div>
            <div className="moda-recovery-effective-card">
              <span>{i18n.t("recoverySettings.offer.title")}</span>
              <strong>
                {i18n.t("recoverySettings.effectiveOffer", {
                  value: i18n.t(
                    `recoverySettings.offer.${effective.recoveryOfferMode}`,
                  ),
                })}
              </strong>
            </div>
            <div className="moda-recovery-effective-card">
              <span>{i18n.t("recoverySettings.followUp.title")}</span>
              <strong>
                {effective.followUpEnabled
                  ? i18n.t("recoverySettings.effectiveFollowUpEnabled", {
                      value: effective.followUpDelayMinutes,
                    })
                  : i18n.t("recoverySettings.effectiveFollowUpDisabled")}
              </strong>
            </div>
          </div>
        </section>

        {data.overrideActive ? (
          <div
            className="moda-recovery-notice moda-recovery-notice-warning"
            role="status"
          >
            <span className="moda-recovery-notice-icon" aria-hidden="true">
              !
            </span>
            <p>{i18n.t("recoverySettings.adminOverride")}</p>
          </div>
        ) : null}
        <FeaturePreferences snapshot={data.features} t={i18n.t} />
        <p>{i18n.t("merchantFeatures.discountHelp")}</p>
        <SettingsForm revision={data.revision} intent="recovery" t={i18n.t}>
          <section
            className="moda-recovery-panel"
            aria-labelledby="recovery-start-heading"
          >
            <div className="moda-recovery-panel-heading">
              <span className="moda-recovery-step" aria-hidden="true">
                1
              </span>
              <div>
                <h2 id="recovery-start-heading">
                  {i18n.t("recoverySettings.start.title")}
                </h2>
                <p>{i18n.t("recoverySettings.start.label")}</p>
              </div>
            </div>
            <div className="moda-recovery-setting-row">
              <label
                className="moda-recovery-number-control"
                htmlFor="recoveryDelayMinutes"
              >
                <span>{i18n.t("recoverySettings.start.label")}</span>
                <input
                  id="recoveryDelayMinutes"
                  type="number"
                  name="recoveryDelayMinutes"
                  min="0"
                  max="10080"
                  defaultValue={data.merchant.recoveryDelayMinutes}
                />
              </label>
              <div className="moda-recovery-effective-value">
                {i18n.t("recoverySettings.effective", {
                  value: effective.recoveryDelayMinutes,
                })}
              </div>
            </div>
          </section>

          <section
            className="moda-recovery-panel"
            aria-labelledby="recovery-offer-heading"
          >
            <div className="moda-recovery-panel-heading">
              <span className="moda-recovery-step" aria-hidden="true">
                2
              </span>
              <div>
                <h2 id="recovery-offer-heading">
                  {i18n.t("recoverySettings.offer.title")}
                </h2>
                <p>
                  {i18n.t("recoverySettings.effectiveOffer", {
                    value: i18n.t(
                      `recoverySettings.offer.${effective.recoveryOfferMode}`,
                    ),
                  })}
                </p>
              </div>
            </div>

            <fieldset className="moda-recovery-offer-options">
              <legend className="moda-recovery-visually-hidden">
                {i18n.t("recoverySettings.offer.title")}
              </legend>
              {(["NONE", "FIXED", "AI_BEST_APPLICABLE"] as const).map(
                (mode) => (
                  <label
                    className={`moda-recovery-choice${selectedOfferMode === mode ? " is-selected" : ""}`}
                    key={mode}
                  >
                    <input
                      type="radio"
                      name="recoveryOfferMode"
                      value={mode}
                      checked={selectedOfferMode === mode}
                      onChange={() => setSelectedOfferMode(mode)}
                    />
                    <span
                      className="moda-recovery-choice-mark"
                      aria-hidden="true"
                    />
                    <span className="moda-recovery-choice-copy">
                      <strong>
                        {i18n.t(`recoverySettings.offer.${mode}`)}
                      </strong>
                      {mode === "AI_BEST_APPLICABLE" ? (
                        <small>
                          {i18n.t("recoverySettings.aiDescription")}
                        </small>
                      ) : null}
                    </span>
                  </label>
                ),
              )}
            </fieldset>

            {selectedOfferMode === "FIXED" ? (
              <div className="moda-recovery-fixed-discounts">
                <div className="moda-recovery-subsection-heading">
                  <h3>{i18n.t("recoverySettings.offer.availableDiscounts")}</h3>
                </div>
                {data.catalogueStatus === "CURRENT" &&
                data.discounts.length > 0 ? (
                  <div className="moda-recovery-discount-grid">
                    {data.discounts.map((discount: DiscountRow) => (
                      <label
                        aria-label={discount.title ?? discount.id}
                        key={discount.id}
                        className={`moda-recovery-discount-card${selectedFixedDiscountId === discount.id ? " is-selected" : ""}${!discount.fixedSelectable ? " is-disabled" : ""}`}
                      >
                        <input
                          type="radio"
                          name="fixedShopifyDiscountId"
                          value={discount.id}
                          checked={selectedFixedDiscountId === discount.id}
                          onChange={() =>
                            setSelectedFixedDiscountId(discount.id)
                          }
                          disabled={!discount.fixedSelectable}
                        />
                        <span
                          className="moda-recovery-choice-mark"
                          aria-hidden="true"
                        />
                        <span className="moda-recovery-discount-copy">
                          <strong>{discount.title}</strong>
                          <span className="moda-recovery-discount-meta">
                            {discount.summary ? (
                              <span>
                                {i18n.t("recoverySettings.discount.summary", {
                                  value: discount.summary,
                                })}
                              </span>
                            ) : null}
                            <span>
                              {i18n.t("recoverySettings.discount.method", {
                                value: i18n.t(
                                  `recoverySettings.discount.method.${discount.method}`,
                                ),
                              })}
                            </span>
                            {discount.singleRedeemCode ? (
                              <span>
                                {i18n.t("recoverySettings.discount.code", {
                                  value: discount.singleRedeemCode,
                                })}
                              </span>
                            ) : null}
                            {discount.startsAt ? (
                              <span>
                                {i18n.t("recoverySettings.discount.startsAt", {
                                  value: i18n.formatDateTime(discount.startsAt),
                                })}
                              </span>
                            ) : null}
                            {discount.endsAt ? (
                              <span>
                                {i18n.t("recoverySettings.discount.endsAt", {
                                  value: i18n.formatDateTime(discount.endsAt),
                                })}
                              </span>
                            ) : null}
                            <span>
                              {i18n.t("recoverySettings.discount.status", {
                                value: i18n.t(
                                  `recoverySettings.discount.status.${discount.providerStatus}`,
                                ),
                              })}
                            </span>
                            {!discount.fixedSelectable ? (
                              <span>
                                {i18n.t("recoverySettings.offer.notSelectable")}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <div className="moda-recovery-inline-message">
                    <span aria-hidden="true">i</span>
                    <p>
                      {i18n.t(
                        discountCatalogueMessageKey(data.catalogueStatus),
                      )}
                    </p>
                  </div>
                )}
              </div>
            ) : null}

            {effective.recoveryOfferMode === "FIXED" &&
            data.effectiveFixedDiscount ? (
              <div className="moda-recovery-effective-value moda-recovery-effective-value-full">
                {i18n.t("recoverySettings.effectiveFixedDiscount", {
                  value:
                    data.effectiveFixedDiscount.title ??
                    data.effectiveFixedDiscount.id,
                })}
              </div>
            ) : null}
          </section>

          <section
            className="moda-recovery-panel"
            aria-labelledby="recovery-follow-up-heading"
          >
            <div className="moda-recovery-panel-heading">
              <span className="moda-recovery-step" aria-hidden="true">
                3
              </span>
              <div>
                <h2 id="recovery-follow-up-heading">
                  {i18n.t("recoverySettings.followUp.title")}
                </h2>
                <p>
                  {effective.followUpEnabled
                    ? i18n.t("recoverySettings.effectiveFollowUpEnabled", {
                        value: effective.followUpDelayMinutes,
                      })
                    : i18n.t("recoverySettings.effectiveFollowUpDisabled")}
                </p>
              </div>
            </div>

            <div className="moda-recovery-follow-up-grid">
              <label
                className={`moda-recovery-toggle-card${followUpEnabled ? " is-selected" : ""}`}
              >
                <input
                  type="checkbox"
                  name="followUpEnabled"
                  checked={followUpEnabled}
                  onChange={(event) =>
                    setFollowUpEnabled(event.currentTarget.checked)
                  }
                />
                <span className="moda-recovery-toggle" aria-hidden="true">
                  <span />
                </span>
                <span>{i18n.t("recoverySettings.followUp.enable")}</span>
              </label>
              <label
                className={`moda-recovery-number-control${!followUpEnabled ? " is-disabled" : ""}`}
                htmlFor="followUpDelayMinutes"
              >
                <span>{i18n.t("recoverySettings.followUp.delay")}</span>
                <input
                  id="followUpDelayMinutes"
                  type="number"
                  name="followUpDelayMinutes"
                  min="1"
                  max="10080"
                  defaultValue={data.merchant.followUpDelayMinutes ?? ""}
                  disabled={!followUpEnabled}
                />
              </label>
            </div>

            <div className="moda-recovery-credit-note">
              <span aria-hidden="true">i</span>
              <p>{i18n.t("recoverySettings.followUp.creditWarning")}</p>
            </div>
          </section>
        </SettingsForm>
      </div>
    </s-page>
  );
}
