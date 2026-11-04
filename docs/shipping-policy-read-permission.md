# Shopify shipping-policy read permission

The Admin 2026-07 `ShopPolicy` resource requires `read_legal_policies`. The two deployable app configurations declare it as a required scope. Native policy reads become available for a shop after its actual offline installation grant includes that permission. [ShopPolicy reference](https://shopify.dev/docs/api/admin-graphql/2026-07/objects/ShopPolicy)

## Select the app and align runtime scopes

| Configuration | Client ID | Application URL | Webhook API version |
| --- | --- | --- | --- |
| `shopify.app.moda-interact.toml` | `c323c5bd8585d875719db7570b91460e` | `https://app-test.modainteract.com` | `2026-07` |
| `shopify.app.toml` | `ca78b7deba6ed1da8a15997bbe905242` | `https://moda-interact.onrender.com` | `2026-10` |

Confirm the selected configuration against the intended deployed app/client in the Dev Dashboard and deployment records. The named configuration follows the existing ARCH-049/ARCH-045 integration precedent. The actual deployed selection requires operator verification. The `.good` and `.test` variants of the named file retain their ARCH-049 snapshot classification.

For the named app, validate the explicit selection from the app checkout using the installed project tooling.

```bash
npx shopify app config validate --config moda-interact
```

For the default app, select and validate `shopify.app.toml` for its own client. Preserve each app's existing required scopes, URLs, distribution, redirect URLs and subscriptions when selecting or deploying it. Follow Shopify's configuration selection workflow for the intended target. [Manage app configuration files](https://shopify.dev/docs/apps/build/cli-for-apps/manage-app-config-files)

The runtime independently reads `SCOPES` in `app/shopify.server.js` and obtains its API key from the platform configuration service. Compare that deployed key with the selected client ID. A mismatch fails the rollout gate. Align external `SCOPES` with all required permissions for that selected app, including `read_legal_policies`, and retain its unrelated permissions. Apply external configuration through the existing deployment process and ensure the runtime uses the updated value.

## Deploy and obtain approval

These steps are operator rollout actions after review. This implementation task records them as `NOT_RUN`.

1. Validate the selected app and runtime alignment above. Record the selected client and intended app version without recording credentials.
2. Deploy the selected required-scope configuration. For the named app, the existing command is `npx shopify app deploy --config moda-interact`. Verify the resulting app version includes the new required scope and its existing `app/scopes_update` subscription.
3. Have the merchant open the embedded app and complete Shopify's normal required-scope approval when prompted. Use the existing authenticated `/auth/*` lifecycle for authentication and token/session persistence. Capture whether approval completed for that installation. [Manage app access scopes](https://shopify.dev/docs/apps/build/authentication-authorization/manage-access-scopes)

Configuration deployment, merchant approval, receipt of an authenticated scope-update notification and a currently usable persisted offline grant are separate evidence. The existing scope-update route authenticates the notification and stores its reported scope when the authenticated session is present. Its Shop-before-Session transaction, missing-shop/session handling, persisted offline discount eligibility and after-commit discount publication continue through the existing lifecycle.

## Verify the offline grant used by MCP

Resolve the same shop's persisted offline `shopify.Session` through the existing trusted connection/session path used by MCP. Confirm its shop/domain and `isOnline = false`, and inspect whether its persisted scope contains the exact `read_legal_policies` handle. Keep the token and session row private.

Using the authorized Admin client for that offline installation, perform this read-only grant check. The app runtime's Admin version is `2026-07`.

```graphql
query GrantedShippingPolicyScopes {
  currentAppInstallation {
    accessScopes {
      handle
    }
  }
}
```

Inspect GraphQL `errors` even with HTTP 200, require a successful installation result, and check the exact returned scope handle. Compare it with the persisted offline scope used by MCP. An inconsistency leaves that shop's policy rollout unverified and requires investigation through the existing approval/authentication/session lifecycle. Record only bounded grant status and approved nonsecret installation/version identifiers. [Current app installation](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/currentAppInstallation)

An online grant, another shop or app's token, external `SCOPES`, or the webhook payload alone cannot establish this offline grant. Missing approval or persisted scope keeps native policy access unavailable for that shop. Complete the existing approval/refresh flow and repeat the verification. Session scope must remain Shopify-reported data.

## Downstream behavior and rollout record

ARCH-058-MCP-003 implements the frozen shipping contract. Its credential-owning provider checks trusted persisted offline `read_legal_policies` before requesting native policy data. For a valid offline session, an absent/null/blank stored permission produces policy status `SCOPE_NOT_GRANTED` with zero policy requests. Missing or invalid offline credentials remain an actual error. Independent authorized product discovery and product shipping facts remain usable. An HTTP 401/403 or GraphQL failure after an attempted granted request remains an actual error with its original diagnostics.

Record the following per shop during rollout.

- Selected app/client, deployed app version, required-scope configuration and external runtime alignment.
- Merchant approval outcome, authenticated scope-update observation and current persisted offline grant.
- Successful offline `currentAppInstallation.accessScopes` verification or the specific unresolved permission/error outcome.
- Local configuration/lifecycle test and typecheck results.
- Deployment, approval, offline-grant verification and native policy readiness as `NOT_RUN` until their actual evidence exists.

MCP-003 owns policy querying and readiness. The local configuration checks establish declarations and source preservation. Live grant verification remains an operator prerequisite for that shop's native shipping policy.
