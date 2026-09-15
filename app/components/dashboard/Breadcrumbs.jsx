import React from "react";
import PropTypes from "prop-types";
import { Link } from "react-router";
import { createMerchantI18n } from "../../utils/merchant-i18n";

/**
 * @param {{ items?: Array<{ label: string, href: string }>, current?: string, merchantUi?: { locale?: string, timeZone?: string } }} props
 */
export default function Breadcrumbs({ items = [], current, merchantUi }) {
  const i18n = createMerchantI18n(merchantUi);
  return (
    <nav className="dashboard-breadcrumbs" aria-label={i18n.t("navigation.breadcrumb")}>
      {items.map((item) => <span key={`${item.href}:${item.label}`}><Link to={item.href}>{item.label}</Link><span aria-hidden="true">/</span></span>)}
      <strong aria-current="page">{current}</strong>
    </nav>
  );
}

Breadcrumbs.propTypes = {
  items: PropTypes.arrayOf(PropTypes.shape({ label: PropTypes.string.isRequired, href: PropTypes.string.isRequired })),
  current: PropTypes.string,
  merchantUi: PropTypes.shape({ locale: PropTypes.string, timeZone: PropTypes.string }),
};