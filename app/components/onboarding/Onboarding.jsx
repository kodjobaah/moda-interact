import PropTypes from "prop-types";
import { createMerchantI18n } from "../../utils/merchant-i18n";

export default function Onboarding({ merchantUi }) {
  const i18n = createMerchantI18n(merchantUi);

  return (
    <s-page heading={i18n.t("onboarding.title")}>
      <s-section>
        <s-heading>
          {i18n.t("onboarding.heading")}
        </s-heading>

        <s-paragraph>
          {i18n.t("onboarding.description")}
        </s-paragraph>
      </s-section>

      <s-section>
        <s-heading>
          {i18n.t("onboarding.getStarted")}
        </s-heading>

        <s-paragraph>
          {i18n.t("onboarding.planDescription")}
        </s-paragraph>

        <s-button href="/app/billing">{i18n.t("onboarding.choosePlan")}</s-button>
      </s-section>
    </s-page>
  );
}

Onboarding.propTypes = {
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
};