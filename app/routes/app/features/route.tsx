import { redirect } from "react-router";

export const FEATURES_REDIRECT =
  "/app/recovery-settings#conversation-features";

export function loader() {
  return redirect(FEATURES_REDIRECT);
}

export function action() {
  return redirect(FEATURES_REDIRECT, 303);
}

export default function FeaturesCompatibilityRoute() {
  return null;
}
