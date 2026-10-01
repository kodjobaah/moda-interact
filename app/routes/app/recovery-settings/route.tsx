import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import {
  loadFeaturePreferences,
  PreferenceError,
} from "@/services/feature-preferences/feature-preferences.server";
import { loadRecoveryPolicySnapshot } from "@/services/recovery-policy/recovery-policy.server";
import { loadMerchantKnowledge } from "@/services/merchant-knowledge/merchant-knowledge.server";
import { merchantUiContext } from "@/utils/merchant-i18n";
import { listSelectableStoreCategories, loadStoreProfile } from "@/services/store-profile/store-category.server";
import RecoverySettingsView from "./RecoverySettingsView";
export async function loader({ request }: LoaderFunctionArgs) {
  const { shop, settings, session } = await settingsAccess(request);
  const merchantUi = merchantUiContext(settings, session);
  const [storeCategories, storeProfile] = await Promise.all([
    listSelectableStoreCategories(merchantUi.locale),
    loadStoreProfile(shop.id, merchantUi.locale),
  ]);
  const merchantKnowledge = await loadMerchantKnowledge(shop.id);
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
    storeCategories,
    storeProfile,
    merchantKnowledge,
    merchantUi,
  };
}
export { action } from "../settings-save/route";

export default function RecoverySettingsRoute() {
  const data = useLoaderData<typeof loader>();
  return <RecoverySettingsView data={data} />;
}
