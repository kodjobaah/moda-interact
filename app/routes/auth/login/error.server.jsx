import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

/** @param {any} loginErrors */
export function loginErrorMessage(loginErrors) {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "Please enter your shop domain to log in" };
  } else if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return { shop: "Start installation from your Shopify admin or the Moda Interact app listing so Shopify can verify your store." };
  }

  return {};
}
