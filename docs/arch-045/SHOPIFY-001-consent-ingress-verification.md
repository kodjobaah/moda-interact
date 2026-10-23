# ARCH-045-SHOPIFY-001 — consent webhook verification boundary

## Source snapshot (2026-10-23)

- `shopify.app.moda-interact.toml` declares the application's `2026-07` webhook API, existing `/webhooks` checkout/cart/order topics, and `read_customers`. This task adds the exact `customers_whats_app_marketing_consent/update` topic to that subscription. No `write_customers` is required.
- `shopify.app.toml` is **a different application client and API version** (`2026-10`) with template-level scopes. It is not silently edited or treated as the deployed configuration.
- The two TOML files and repository scripts do not provide evidence identifying which Partner Dashboard app/version was most recently deployed. Live deployment and token grants cannot be established from this portable snapshot.
- Shopify documentation for the `2026-07` topic shows a JSON numeric `customer_id` and a `phone_number`. Ingress retains the authenticated raw number so large Shopify IDs are not rounded, then publishes only `{schemaVersion, shopId, shopifyCustomerId, deliveryId, triggeredAt}` through Shared v1.
- Background's read-only provider targets `2026-07` and queries `customer(id) { id defaultPhoneNumber { phoneNumber whatsAppMarketingConsent { state updatedAt } } }`. The Shopify ingress does not call this API.

## Release-gate evidence still required in developer's environment

1. Check the Shopify CLI current selected configuration, deployed app client ID, API version and subscriptions against `shopify.app.moda-interact.toml` and the actual Partner Dashboard. Ensure the consent topic is installed for the selected app; do not treat this TOML change as deployment evidence.
2. Verify the **installed** test-shop token has `read_customers` and any relevant protected customer-data approval. If it does not, follow Shopify's approved re-authorisation and data-access review process. Do not request `write_customers` for STOP.
3. With a non-production, consented test customer, execute a read-only GraphQL smoke using that installation token. Verify HTTP status **and** absence of GraphQL `errors`/field access denials; compare returned `customer.id` with the webhook ID converted using the Shared identity helper. Query:

```graphql
query CustomerWhatsAppConsent($id: ID!) {
  customer(id: $id) {
    id
    defaultPhoneNumber {
      phoneNumber
      whatsAppMarketingConsent { state updatedAt }
    }
  }
}
```

4. Validate a signed webhook's acknowledgement after a durable `shopify-whatsapp-consent-sync` job enqueue; missing Redis and invalid identity should not receive successful enqueue acknowledgements. Verify the Background consumer from `ARCH-045-BACKGROUND-003` is deployed **before** enabling this producer subscription, because older checkout workers do not yet recognise the new job name.
5. In the canonical implementation worktree, run `npm ci`, `npm run prisma:generate` (the generated `@prisma/client` types are required before typecheck), the focused Shopify unit tests, lint, typecheck and other task-required checks. This portable archive has no installed `node_modules` and cannot demonstrate these checks.

**No live CLI access, Shopify token, protected-data grant, or smoke-test result is included in the supplied snapshot.** These are release blockers to report, not assumed successes. The source change is implementation-only; the task's parent-worktree Completion Report and approval remain owned by the normal task workflow.
