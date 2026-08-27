import PropTypes from "prop-types";
import { Link } from "react-router";

export default function Breadcrumbs({ current, parent, parentHref = "/app" }) {
  return (
    <nav className="dashboard-breadcrumbs" aria-label="Breadcrumb">
      {current !== "Usage overview" && <>
        <Link to="/app">Usage overview</Link>
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
};