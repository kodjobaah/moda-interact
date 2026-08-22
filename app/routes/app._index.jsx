import Dashboard from "../components/Dashboard";
import Onboarding from "../components/Onboarding";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const settings = await db.shopSettings.findUnique({
    where: {
      shop: session.shop,
    },
  });

  return {
    settings,
  };
};

export default function Index() {
  const { settings } = useLoaderData();

  if (!settings) {
    return <Onboarding />;
  }

  return <Dashboard settings={settings} />;
}