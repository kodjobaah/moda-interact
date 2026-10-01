const {
  SHOPIFY_PARTNER_ORG_ID,
  SHOPIFY_PARTNER_ACCESS_TOKEN,
  SHOPIFY_PARTNER_API_VERSION = "2026-07",
} = process.env;

const TARGET_EVENT_ID =
  "gid://partners/SubscriptionStatus/051bab77-a93e-593b-8b5a-ff21c0c400d0";

const SHOP_ID =
  "gid://shopify/Shop/101762498853";

const APP_ID =
  "gid://shopify/App/413747675137";

// We already know this event happened at:
// 2026-09-14T21:21:06Z
//
// Use a narrow window around it.
const OCCURRED_AT_MIN =
  "2026-09-14T21:20:00Z";

const OCCURRED_AT_MAX =
  "2026-09-14T21:22:00Z";

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Missing ${name}`);
  }

  return value;
}

requireEnv(
  "SHOPIFY_PARTNER_ORG_ID",
  SHOPIFY_PARTNER_ORG_ID,
);

requireEnv(
  "SHOPIFY_PARTNER_ACCESS_TOKEN",
  SHOPIFY_PARTNER_ACCESS_TOKEN,
);

const endpoint =
  `https://partners.shopify.com/` +
  `${SHOPIFY_PARTNER_ORG_ID}/api/` +
  `${SHOPIFY_PARTNER_API_VERSION}/graphql.json`;

const query = `
  query FindSubscriptionStatus(
    $filter: EventFilterInput!
  ) {
    events(
      first: 100
      filter: $filter
      orderBy: OCCURRED_AT_DESC
    ) {
      edges {
        node {
          id
          eventType
          occurredAt

          shop {
            id
            myshopifyDomain
          }

          subject {
            __typename

            ... on AppReference {
              id
              name
              apiKey
            }
          }

          ... on SubscriptionStatus {
            state
            cancelEffectiveOn

            plan {
              handle
              billingPeriod
              trialDays
              trialDaysRemaining

              prices {
                __typename
              }
            }
          }
        }
      }

      pageInfo {
        hasNextPage
      }
    }
  }
`;

const variables = {
  filter: {
    shopId: SHOP_ID,
    subjectId: APP_ID,

    eventTypes: [
      "SUBSCRIPTION_UPDATED",
    ],

    occurredAtMin: OCCURRED_AT_MIN,
    occurredAtMax: OCCURRED_AT_MAX,
  },
};

console.log("QUERYING PARTNER API");
console.log("====================");
console.log("Target event:", TARGET_EVENT_ID);
console.log("Endpoint:", endpoint);

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token":
      SHOPIFY_PARTNER_ACCESS_TOKEN,
  },
  body: JSON.stringify({
    query,
    variables,
  }),
});

const body = await response.json();

if (!response.ok || body.errors) {
  console.error(
    "\nPARTNER API ERROR\n=================",
  );

  console.error(
    JSON.stringify(body, null, 2),
  );

  process.exit(1);
}

const events =
  body.data?.events?.edges?.map(
    (edge) => edge.node,
  ) ?? [];

console.log(
  `\nReturned ${events.length} event(s).`,
);

const target = events.find(
  (event) => event.id === TARGET_EVENT_ID,
);

if (!target) {
  console.log(
    "\nTARGET EVENT NOT FOUND",
  );

  console.log(
    "Events returned by Shopify:",
  );

  for (const event of events) {
    console.log({
      id: event.id,
      eventType: event.eventType,
      occurredAt: event.occurredAt,
    });
  }

  process.exit(2);
}

console.log(
  "\nSUBSCRIPTION STATUS FOUND",
);

console.log(
  "=========================",
);

console.log(
  JSON.stringify(target, null, 2),
);
