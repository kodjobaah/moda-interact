import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";

export default function Onboarding({ merchantUi }) {
  const i18n = createMerchantI18n(merchantUi);

  return (
    <s-page heading={i18n.t("onboarding.title")}>
      <div
        style={{
          maxWidth: 760,
          margin: "0 auto",
          padding: "24px 0 48px",
        }}
      >
        <s-section>
          <div
            style={{
              padding: "16px 0",
            }}
          >
            <s-heading>
              {i18n.t("onboarding.heading")}
            </s-heading>

            <div style={{ marginTop: 12 }}>
              <s-paragraph>
                {i18n.t("onboarding.description")}
              </s-paragraph>
            </div>
          </div>
        </s-section>

        <div style={{ marginTop: 24 }}>
          <s-section>
            <s-heading>
              {i18n.t("onboarding.getStarted")}
            </s-heading>

            <div style={{ marginTop: 12 }}>
              <s-paragraph>
                {i18n.t("onboarding.planDescription")}
              </s-paragraph>
            </div>

            <div style={{ marginTop: 24 }}>
              <s-button href="/app/billing?onboarding=complete">
                {i18n.t("onboarding.choosePlan")}
              </s-button>
            </div>
          </s-section>
        </div>
      </div>
    </s-page>
  );
}

Onboarding.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
};