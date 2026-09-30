import {
  useLoaderData,
  useNavigation,
  useRevalidator,
  useRouteError,
  type HeadersFunction,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadRecoveryDetail } from "./loader.server";
import RecoveryDetail from "./RecoveryDetail";
export const loader = loadRecoveryDetail;
export default function RecoveryDetailRoute() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation(),
    revalidator = useRevalidator();
  return (
    <RecoveryDetail
      key={data.detail?.id ?? data.state}
      data={data}
      busy={navigation.state !== "idle" || revalidator.state !== "idle"}
      onRefresh={() => revalidator.revalidate()}
    />
  );
}
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
