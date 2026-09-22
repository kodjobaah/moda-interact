import React, { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { useRevalidator } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";
import "./BillingSetupStatus.css";

const POLL_INTERVAL_MS = 4_000;

/** @param {{ merchantUi: any, setup: any, standalone?: boolean }} props */
export default function BillingSetupStatus({ merchantUi, setup, standalone = false }) {
  const i18n = createMerchantI18n(merchantUi);
  const revalidator = useRevalidator();
  const [liveSetup, setLiveSetup] = useState(setup);
  const confirmed = liveSetup?.phase === "FINALIZING_SUBSCRIPTION";

  useEffect(() => {
    setLiveSetup(setup);
  }, [setup]);

  useEffect(() => {
    let cancelled = false;

    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/app/billing/status", {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (!response.ok || cancelled) return;
        const status = await response.json();
        if (!status.requiresSetupScreen && revalidator.state === "idle") {
          revalidator.revalidate();
          return;
        }
        if (status.setup) {
          setLiveSetup((/** @type {any} */ current) => ({
            ...current,
            ...status.setup,
            planName: status.setup.planHandle === current?.planHandle && current?.planName
              ? current.planName
              : status.setup.planName,
          }));
        }
      } catch {
        // The durable background reconciliation remains authoritative. A transient
        // browser poll failure must not alter billing state or interrupt the page.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [revalidator]);

  const title = confirmed
    ? i18n.t("billingSetup.confirmedTitle")
    : i18n.t("billingCommerce.plans.awaitingShopifyConfirmation");
  const description = confirmed
    ? i18n.t("billingSetup.confirmedDescription")
    : i18n.t("billingSetup.waitingDescription");
  const status = confirmed
    ? i18n.t("billingSetup.finalizingStatus")
    : i18n.t("billingCommerce.plans.awaitingShopifyConfirmation");

  const content = (
    <section className="mi-billing-setup" aria-live="polite" aria-labelledby="mi-billing-setup-title">
      <div className="mi-billing-setup-progress" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="mi-billing-setup-copy">
        <div className="mi-billing-setup-eyebrow">{status}</div>
        <h2 id="mi-billing-setup-title">{title}</h2>
        <p>{description}</p>

        <dl className="mi-billing-setup-details">
          <div>
            <dt>{i18n.t("billing.currentPlan")}</dt>
            <dd>{liveSetup?.planName || liveSetup?.planHandle || i18n.t("billing.unknownPlan")}</dd>
          </div>
          <div>
            <dt>{i18n.t("billing.status")}</dt>
            <dd>{status}</dd>
          </div>
          {liveSetup?.currentPeriodStart && liveSetup?.currentPeriodEnd ? (
            <div className="mi-billing-setup-wide">
              <dt>{i18n.t("dashboard.billingPeriod")}</dt>
              <dd>{i18n.t("billing.currentPeriod", {
                start: i18n.formatDate(liveSetup.currentPeriodStart),
                end: i18n.formatDate(liveSetup.currentPeriodEnd),
              })}</dd>
            </div>
          ) : null}
          {liveSetup?.lastSyncedAt ? (
            <div className="mi-billing-setup-wide">
              <dt>{i18n.t("pending.lastActivity")}</dt>
              <dd>{i18n.t("pending.lastUpdated", { time: i18n.formatTime(liveSetup.lastSyncedAt) })}</dd>
            </div>
          ) : null}
        </dl>

        <p className="mi-billing-setup-note">{i18n.t("billingSetup.automaticRefresh")}</p>
      </div>
    </section>
  );

  return standalone
    ? <s-page heading={i18n.t("billingSetup.pageTitle")}><div className="mi-billing-setup-shell">{content}</div></s-page>
    : content;
}

BillingSetupStatus.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
  setup: PropTypes.shape({
    phase: PropTypes.oneOf(["AWAITING_SHOPIFY_CONFIRMATION", "FINALIZING_SUBSCRIPTION"]).isRequired,
    planHandle: PropTypes.string,
    planName: PropTypes.string,
    currentPeriodStart: PropTypes.string,
    currentPeriodEnd: PropTypes.string,
    lastSyncedAt: PropTypes.string,
  }).isRequired,
  standalone: PropTypes.bool,
};
