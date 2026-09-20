import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import {
  loadFeaturePreferences,
  PreferenceError,
} from "@/services/feature-preferences/feature-preferences.server";
import { loadRecoveryPolicySnapshot } from "@/services/recovery-policy/recovery-policy.server";
import { merchantUiContext } from "@/utils/merchant-i18n";
import RecoverySettingsView from "./RecoverySettingsView";
export async function loader({ request }: LoaderFunctionArgs) {
  const { shop, settings, session } = await settingsAccess(request);
  const features = await loadFeaturePreferences(shop.id).catch(
    (error: unknown) => {
      if (error instanceof PreferenceError)
        return { revision: "", features: [], denied: true };
      throw error;
    },
  );
  return {
    ...(await loadRecoveryPolicySnapshot(shop.id)),
    features,
    merchantUi: merchantUiContext(settings, session),
  };
}
export { action } from "../settings-save/route";

export default function RecoverySettingsRoute() {
  const data = useLoaderData<typeof loader>();
  return <RecoverySettingsView data={data} />;
}
