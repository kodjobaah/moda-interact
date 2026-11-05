# Shopify Webhook Configuration

`shopify.app.moda-interact.toml` is the intended Moda Interact application configuration for the package `dev`, `deploy`, `shopify`, `shopify:dev`, and `shopify:dev:cloud` commands. The first three custom launchers pass `--config moda-interact` to their Shopify CLI child process. The named configuration retains its existing client ID, `https://app-test.modainteract.com` URLs, API version `2026-07`, and access scopes; the local configuration change does not deploy an app version or establish which subscriptions are currently deployed remotely.

| Route | Topics |
|---|---|
| `/webhooks` | `orders/create`, `carts/create`, `carts/update`, `checkouts/create`, `checkouts/update`, `customers_whats_app_marketing_consent/update`, `discounts/create`, `discounts/update`, `discounts/delete`, `discounts/redeemcode_added`, `discounts/redeemcode_removed` |
| `/webhooks/app/uninstalled` | `app/uninstalled` |
| `/webhooks/app/scopes_update` | `app/scopes_update` |
| `/webhooks/customers/data_request` | compliance `customers/data_request` |
| `/webhooks/customers/redact` | compliance `customers/redact` |
| `/webhooks/shop/redact` | compliance `shop/redact` |

`shopify.app.toml` remains a separate template app configuration with its own client ID, URL, scopes, API version, and subscriptions. To intentionally use it, run the Shopify CLI directly with the default config selection, for example `npx shopify app dev --config shopify.app.toml`; the Moda Interact package scripts continue to select `moda-interact` explicitly. `npx shopify app config validate --config moda-interact` validates the local named configuration without deploying or releasing an app version.
