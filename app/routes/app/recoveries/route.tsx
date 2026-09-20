import {
  useLoaderData,
  useNavigation,
  useRevalidator,
  useRouteError,
} from "react-router";
import type { HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadRecoveryList } from "./loader.server";
import RecoveryList from "./RecoveryList";

export const loader = loadRecoveryList;
export default function RecoveryListRoute() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  return (
    <RecoveryList
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
