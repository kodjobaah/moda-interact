import PropTypes from "prop-types";
import { Link } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";

export default function Breadcrumbs({ current, parent, parentHref = "/app", merchantUi }) {
  const i18n = createMerchantI18n(merchantUi);
  return (
    <nav className="dashboard-breadcrumbs" aria-label={i18n.t("navigation.breadcrumb")}>
      {current !== i18n.t("usage.title") && <>
        <Link to="/app">{i18n.t("usage.title")}</Link>
        <span aria-hidden="true">/</span>
      </>}
      {parent && <>
        <Link to={parentHref}>{parent}</Link>
        <span aria-hidden="true">/</span>
      </>}
      <strong>{current}</strong>
    </nav>
  );
}

Breadcrumbs.propTypes = {
  current: PropTypes.string,
  parent: PropTypes.string,
  parentHref: PropTypes.string,
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
};