import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadRecoverySection } from "./loader.server";
export const loader = (args: LoaderFunctionArgs) =>
  loadRecoverySection(args, "related");
export const headers: HeadersFunction = (args) => boundary.headers(args);
