# Moda WhatsApp checkout consent

This Shopify Checkout UI extension is configured for the Plus checkout target
`purchase.checkout.contact.render-after`. It displays the buyer's current
verified checkout receipt (or verified returning-customer status) and only
requests a new receipt after an explicit checkbox change.

The extension uses the checkout session token for authenticated requests to
`POST /shopify/checkout/receipt`. It writes only the signed
`moda_wa_consent_v1` checkout attribute, and hides its control when the checkout
token, signed status response, target, or attribute mutation capability is
unavailable.

The `locales/` directory contains the supported 20 Shopify checkout locales.
Run `shopify app dev` against an eligible Plus development store for end-to-end
validation; unit tests do not establish live checkout availability or
attribute propagation.
