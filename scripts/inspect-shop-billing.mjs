#!/usr/bin/env node

import pg from "pg";

const { Client, types } = pg;

// Prisma DateTime columns are PostgreSQL TIMESTAMP WITHOUT TIME ZONE and are
// written as UTC instants. node-postgres otherwise interprets OID 1114 in the
// machine's local timezone, which makes diagnostics appear one hour early in
// British Summer Time (and similarly offset in other local zones).
types.setTypeParser(1114, (value) => new Date(`${value}Z`));

const PARTNER_API_VERSION = process.env.SHOPIFY_PARTNER_API_VERSION || "2026-07";
const LIFECYCLE_EVENT_TYPES = [
  "SUBSCRIPTION_CREATED",
  "SUBSCRIPTION_UPDATED",
  "SUBSCRIPTION_CANCELLATION_SCHEDULED",
  "SUBSCRIPTION_CANCELED",
  "SUBSCRIPTION_FROZEN",
  "SUBSCRIPTION_UNFROZEN",
];

function usage() {
  console.error(`Usage:
  node inspect-shop-billing.mjs <shop-domain> [--no-shopify] [--json]

Examples:
  node --env-file=.env inspect-shop-billing.mjs kwadwo-e4bf4mc4.myshopify.com
  node --env-file=.env inspect-shop-billing.mjs kwadwo-e4bf4mc4
  node --env-file=.env inspect-shop-billing.mjs kwadwo-e4bf4mc4 --no-shopify

Required:
  DATABASE_URL

For Shopify Partner API comparison:
  SHOPIFY_PARTNER_ORG_ID
  SHOPIFY_PARTNER_ACCESS_TOKEN
  SHOPIFY_APP_ID

Optional:
  SHOPIFY_PARTNER_API_VERSION   defaults to 2026-07

Notes:
  * External PostgreSQL connections automatically use sslmode=require unless
    DATABASE_URL explicitly specifies an sslmode.
  * The database transaction is READ ONLY.
  * OAuth/Partner API access tokens are never printed.`);
}

function normalizeShopDomain(value) {
  let domain = String(value ?? "").trim().toLowerCase();
  domain = domain.replace(/^https?:\/\//, "").split("/")[0];

  if (!domain) return "";
  if (!domain.includes(".")) return `${domain}.myshopify.com`;
  return domain;
}

function prepareDatabaseUrl(value) {
  const url = new URL(value);
  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);

  if (!isLocal && !url.searchParams.has("sslmode")) {
    url.searchParams.set("sslmode", "require");
  }

  return url.toString();
}

function safeDatabaseDescriptor(value) {
  try {
    const url = new URL(prepareDatabaseUrl(value));
    return {
      host: url.hostname,
      database: url.pathname.replace(/^\//, ""),
      sslmode: url.searchParams.get("sslmode"),
    };
  } catch {
    return { host: null, database: null, sslmode: null };
  }
}

function quoteIdent(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function heading(title) {
  console.log(`\n${"=".repeat(100)}\n${title}\n${"=".repeat(100)}`);
}

function printRows(title, rows) {
  heading(`${title} (${rows.length})`);
  console.log(rows.length === 0 ? "[]" : json(rows));
}

function addCheck(checks, level, message, details = undefined) {
  checks.push({ level, message, ...(details === undefined ? {} : { details }) });
}

function sortStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))].sort();
}

function sameStringSet(a, b) {
  const left = sortStrings(a);
  const right = sortStrings(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function iso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sameInstant(a, b, toleranceMs = 1000) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return Math.abs(left - right) <= toleranceMs;
}

function decimalAmountToMinorUnits(amount) {
  if (amount == null || amount === "") return null;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

function comparison(checks, {
  name,
  local,
  shopify,
  matches,
  severity = "ERROR",
  note,
}) {
  const row = {
    name,
    result: matches ? "MATCH" : "MISMATCH",
    local,
    shopify,
    ...(note ? { note } : {}),
  };

  if (!matches) {
    addCheck(checks, severity, `Shopify comparison mismatch: ${name}`, {
      local,
      shopify,
      ...(note ? { note } : {}),
    });
  }

  return row;
}

function partnerApiConfig() {
  return {
    orgId: process.env.SHOPIFY_PARTNER_ORG_ID || null,
    accessToken: process.env.SHOPIFY_PARTNER_ACCESS_TOKEN || null,
    appId: process.env.SHOPIFY_APP_ID || null,
  };
}

async function fetchPartnerBillingSnapshot(shopifyShopId) {
  const { orgId, accessToken, appId } = partnerApiConfig();

  if (!orgId || !accessToken || !appId) {
    return {
      status: "SKIPPED",
      reason: "Missing SHOPIFY_PARTNER_ORG_ID, SHOPIFY_PARTNER_ACCESS_TOKEN, or SHOPIFY_APP_ID",
      apiVersion: PARTNER_API_VERSION,
      activeSubscription: null,
      latestLifecycleEvent: null,
    };
  }

  if (!shopifyShopId) {
    return {
      status: "SKIPPED",
      reason: "commerce.Shop.shopifyShopId is null",
      apiVersion: PARTNER_API_VERSION,
      activeSubscription: null,
      latestLifecycleEvent: null,
    };
  }

  const occurredAtMax = new Date();
  const occurredAtMin = new Date(occurredAtMax.getTime() - 365 * 24 * 60 * 60 * 1000);

  const graphql = `
    query ModaBillingInspection(
      $appId: ID!,
      $shopId: ID!,
      $occurredAtMin: DateTime!,
      $occurredAtMax: DateTime!,
      $eventTypes: [EventType!]
    ) {
      activeSubscription(appId: $appId, shopId: $shopId) {
        app { id name apiKey }
        shop { id myshopifyDomain }
        billingPeriod
        cancelAtEndOfCycle
        trialEndsAt
        currentBillingCycle { startTime endTime }
        items {
          handle
          description
          price {
            __typename
            active
            currency
            ... on FlatRatePrice { amount }
            ... on TieredPrice {
              tiersMode
              tiers { upTo amountPerUnit amount }
            }
          }
          discount {
            amount
            percentage
            originalDiscountCycles
            remainingDiscountCycles
            discountEndsAt
          }
          usage { quantity cost { amount currencyCode } }
        }
        pendingUpdate {
          billingPeriod
          items {
            handle
            description
            price {
              __typename
              active
              currency
              ... on FlatRatePrice { amount }
              ... on TieredPrice {
                tiersMode
                tiers { upTo amountPerUnit amount }
              }
            }
            discount {
              amount
              percentage
              originalDiscountCycles
              remainingDiscountCycles
              discountEndsAt
            }
            usage { quantity cost { amount currencyCode } }
          }
          legacySubscriptionId
        }
        legacySubscriptionId
      }
      events(
        first: 1
        filter: {
          subjectId: $appId
          shopId: $shopId
          eventTypes: $eventTypes
          occurredAtMin: $occurredAtMin
          occurredAtMax: $occurredAtMax
        }
        orderBy: OCCURRED_AT_DESC
      ) {
        edges {
          node {
            __typename
            id
            occurredAt
            eventType
            shop { id }
            subject { __typename ... on AppReference { id } }
            ... on SubscriptionStatus {
              state
              cancelEffectiveOn
              plan { handle billingPeriod }
            }
          }
        }
      }
    }
  `;

  const endpoint = `https://partners.shopify.com/${encodeURIComponent(orgId)}/api/${PARTNER_API_VERSION}/graphql.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({
      query: graphql,
      variables: {
        appId,
        shopId: shopifyShopId,
        occurredAtMin: occurredAtMin.toISOString(),
        occurredAtMax: occurredAtMax.toISOString(),
        eventTypes: LIFECYCLE_EVENT_TYPES,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const responseText = await response.text();
  let result;
  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(`Shopify Partner API returned non-JSON HTTP ${response.status}: ${responseText.slice(0, 500)}`);
  }

  if (!response.ok) {
    throw new Error(`Shopify Partner API HTTP ${response.status}: ${json(result)}`);
  }

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(`Shopify Partner API GraphQL error: ${result.errors.map((error) => error.message).join("; ")}`);
  }

  if (!result.data || !Object.prototype.hasOwnProperty.call(result.data, "activeSubscription")) {
    throw new Error("Shopify Partner API response did not include activeSubscription");
  }

  return {
    status: "OK",
    apiVersion: PARTNER_API_VERSION,
    endpoint: `https://partners.shopify.com/${orgId}/api/${PARTNER_API_VERSION}/graphql.json`,
    appId,
    shopifyShopId,
    activeSubscription: result.data.activeSubscription ?? null,
    latestLifecycleEvent: result.data.events?.edges?.[0]?.node ?? null,
  };
}

function buildShopifyComparison(dump) {
  const rows = [];
  const snapshot = dump.shopifyPartner;
  if (!snapshot || snapshot.status !== "OK") return rows;

  const active = snapshot.activeSubscription;
  const latestEvent = snapshot.latestLifecycleEvent;
  const subscriptions = dump.billing.Subscription ?? [];
  const localSubscription = subscriptions[0] ?? null;
  const plans = dump.catalog.billingPlans ?? [];
  const economics = dump.catalog.economicsSnapshots ?? [];
  const localPlan = localSubscription?.planId
    ? plans.find((plan) => plan.id === localSubscription.planId) ?? null
    : null;

  const activeItems = active?.items?.filter((item) => item?.price?.active !== false) ?? [];
  const activeFlatItems = activeItems.filter((item) => item?.price?.__typename === "FlatRatePrice");
  const activeUsageItems = activeItems.filter((item) => item?.price?.__typename === "TieredPrice");
  const pendingItems = active?.pendingUpdate?.items?.filter((item) => item?.price?.active !== false) ?? [];
  const pendingFlatItems = pendingItems.filter((item) => item?.price?.__typename === "FlatRatePrice");

  const providerPlanHandle =
    activeFlatItems.length === 1
      ? activeFlatItems[0].handle ?? null
      : latestEvent?.plan?.handle ?? null;

  const providerPlanHandleSource =
    activeFlatItems.length === 1
      ? "activeSubscription FlatRatePrice item"
      : latestEvent?.plan?.handle
        ? "latest subscription lifecycle event fallback"
        : "unavailable";

  rows.push(comparison(dump.checks, {
    name: "active contract presence",
    local: localSubscription ? localSubscription.status : null,
    shopify: active ? "ACTIVE_SUBSCRIPTION_PRESENT" : null,
    matches: active ? Boolean(localSubscription) && localSubscription.status !== "NO_CONTRACT" : !localSubscription || localSubscription.status === "NO_CONTRACT",
    severity: "ERROR",
  }));

  if (!active) return rows;

  rows.push(comparison(dump.checks, {
    name: "Shopify shop ID",
    local: dump.anchor.shop?.shopifyShopId ?? null,
    shopify: active.shop?.id ?? null,
    matches: Boolean(dump.anchor.shop?.shopifyShopId) && dump.anchor.shop.shopifyShopId === active.shop?.id,
  }));

  rows.push(comparison(dump.checks, {
    name: "myshopify domain",
    local: dump.shopDomain,
    shopify: active.shop?.myshopifyDomain ?? null,
    matches: String(active.shop?.myshopifyDomain ?? "").toLowerCase() === dump.shopDomain.toLowerCase(),
  }));

  rows.push(comparison(dump.checks, {
    name: "current plan handle",
    local: localPlan?.shopifyPlanHandle ?? localSubscription?.observedShopifyPlanHandle ?? null,
    shopify: providerPlanHandle,
    matches:
      providerPlanHandle != null &&
      [localPlan?.shopifyPlanHandle, localSubscription?.observedShopifyPlanHandle]
        .filter(Boolean)
        .includes(providerPlanHandle),
    note: `Shopify plan handle source: ${providerPlanHandleSource}`,
  }));

  rows.push(comparison(dump.checks, {
    name: "observed Shopify plan handle",
    local: localSubscription?.observedShopifyPlanHandle ?? null,
    shopify: providerPlanHandle,
    matches: localSubscription?.observedShopifyPlanHandle === providerPlanHandle,
  }));

  rows.push(comparison(dump.checks, {
    name: "cancel at end of cycle",
    local: localSubscription?.cancelAtPeriodEnd ?? null,
    shopify: active.cancelAtEndOfCycle,
    matches: Boolean(localSubscription) && localSubscription.cancelAtPeriodEnd === active.cancelAtEndOfCycle,
  }));

  rows.push(comparison(dump.checks, {
    name: "trial end",
    local: iso(localSubscription?.trialEndsAt),
    shopify: iso(active.trialEndsAt),
    matches: sameInstant(localSubscription?.trialEndsAt, active.trialEndsAt),
    severity: "WARN",
  }));

  if (active.currentBillingCycle) {
    rows.push(comparison(dump.checks, {
      name: "current billing cycle start",
      local: iso(localSubscription?.currentPeriodStart),
      shopify: iso(active.currentBillingCycle.startTime),
      matches: sameInstant(localSubscription?.currentPeriodStart, active.currentBillingCycle.startTime),
    }));

    rows.push(comparison(dump.checks, {
      name: "current billing cycle end",
      local: iso(localSubscription?.currentPeriodEnd),
      shopify: iso(active.currentBillingCycle.endTime),
      matches: sameInstant(localSubscription?.currentPeriodEnd, active.currentBillingCycle.endTime),
    }));
  }

  rows.push(comparison(dump.checks, {
    name: "provider subscription ID",
    local: localSubscription?.providerSubscriptionId ?? null,
    shopify: active.legacySubscriptionId ?? null,
    matches:
      localSubscription?.providerSubscriptionId == null ||
      active.legacySubscriptionId == null ||
      localSubscription.providerSubscriptionId === active.legacySubscriptionId,
    severity: "WARN",
    note: "MATCH is also accepted when one side is null because Shopify App Pricing does not require the legacy ID as authority.",
  }));

  const expectedUsageHandles = sortStrings([
    localPlan?.shopifyUsageEventHandle,
    localPlan?.recoveryCreditPackEnabled ? localPlan?.shopifyRecoveryCreditPackEventHandle : null,
  ]);
  const providerUsageHandles = sortStrings(activeUsageItems.map((item) => item.handle));

  rows.push(comparison(dump.checks, {
    name: "active usage meter handles",
    local: expectedUsageHandles,
    shopify: providerUsageHandles,
    matches: sameStringSet(expectedUsageHandles, providerUsageHandles),
    severity: "WARN",
    note: "This compares active TieredPrice item handles with BillingPlan event handles.",
  }));

  const latestEconomics = localPlan
    ? economics
        .filter((snapshotRow) => snapshotRow.billingPlanId === localPlan.id)
        .sort((a, b) => new Date(b.verifiedAt).getTime() - new Date(a.verifiedAt).getTime())[0] ?? null
    : null;

  if (latestEconomics) {
    if (activeFlatItems.length === 1) {
      rows.push(comparison(dump.checks, {
        name: "monthly recurring amount",
        local: {
          minorUnits: latestEconomics.monthlyRecurringAmountMinor,
          currency: latestEconomics.currency,
        },
        shopify: {
          amount: activeFlatItems[0].price.amount,
          currency: activeFlatItems[0].price.currency,
        },
        matches:
          decimalAmountToMinorUnits(activeFlatItems[0].price.amount) === Number(latestEconomics.monthlyRecurringAmountMinor) &&
          String(activeFlatItems[0].price.currency ?? "").toUpperCase() === String(latestEconomics.currency ?? "").toUpperCase(),
        severity: "ERROR",
        note: "Amount comparison interprets BillingEconomicsSnapshot.monthlyRecurringAmountMinor as 1/100 currency units.",
      }));
    } else if (Number(latestEconomics.monthlyRecurringAmountMinor) !== 0) {
      rows.push(comparison(dump.checks, {
        name: "monthly recurring amount",
        local: {
          minorUnits: latestEconomics.monthlyRecurringAmountMinor,
          currency: latestEconomics.currency,
        },
        shopify: activeFlatItems.map((item) => ({ handle: item.handle, price: item.price })),
        matches: false,
        note: "Expected a paid recurring price but Shopify did not return exactly one active FlatRatePrice item.",
      }));
    }
  }

  const pendingProviderPlanHandle = pendingFlatItems.length === 1
    ? pendingFlatItems[0].handle ?? null
    : null;

  rows.push(comparison(dump.checks, {
    name: "pending plan handle",
    local: localSubscription?.pendingShopifyPlanHandle ?? null,
    shopify: pendingProviderPlanHandle,
    matches: (localSubscription?.pendingShopifyPlanHandle ?? null) === pendingProviderPlanHandle,
    severity: "WARN",
  }));

  const providerPendingEffectiveAt = pendingProviderPlanHandle && active.currentBillingCycle
    ? active.currentBillingCycle.endTime
    : null;

  rows.push(comparison(dump.checks, {
    name: "pending plan effective time",
    local: iso(localSubscription?.pendingEffectiveAt),
    shopify: iso(providerPendingEffectiveAt),
    matches: sameInstant(localSubscription?.pendingEffectiveAt, providerPendingEffectiveAt),
    severity: "WARN",
  }));

  if (latestEvent) {
    rows.push(comparison(dump.checks, {
      name: "latest lifecycle event ID",
      local: localSubscription?.lastProviderLifecycleEventId ?? null,
      shopify: latestEvent.id ?? null,
      matches:
        localSubscription?.lastProviderLifecycleEventId == null ||
        localSubscription.lastProviderLifecycleEventId === latestEvent.id,
      severity: "WARN",
      note: "A mismatch can mean local reconciliation has not processed Shopify's latest lifecycle event yet.",
    }));

    rows.push(comparison(dump.checks, {
      name: "latest lifecycle event time",
      local: iso(localSubscription?.lastProviderLifecycleEventAt),
      shopify: iso(latestEvent.occurredAt),
      matches:
        localSubscription?.lastProviderLifecycleEventAt == null ||
        sameInstant(localSubscription.lastProviderLifecycleEventAt, latestEvent.occurredAt),
      severity: "WARN",
    }));
  }

  return rows;
}

const args = process.argv.slice(2);
const input = args.find((arg) => !arg.startsWith("--"));
const noShopify = args.includes("--no-shopify");
const jsonOnly = args.includes("--json");

if (!input) {
  usage();
  process.exit(2);
}

if (!process.env.DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set.");
  process.exit(2);
}

const shopDomain = normalizeShopDomain(input);
const client = new Client({
  connectionString: prepareDatabaseUrl(process.env.DATABASE_URL),
  application_name: "moda-billing-inspector",
});

const dump = {
  inspectedAt: new Date().toISOString(),
  shopDomain,
  database: safeDatabaseDescriptor(process.env.DATABASE_URL),
  anchor: {},
  billing: {},
  catalog: {},
  promotions: {},
  shopifyPartner: null,
  comparison: [],
  checks: [],
};

async function query(text, params = []) {
  return client.query(text, params);
}

let safeQuerySequence = 0;

async function safeQuery(section, text, params = []) {
  const savepoint = `billing_inspector_query_${++safeQuerySequence}`;
  await query(`SAVEPOINT ${savepoint}`);

  try {
    const result = await query(text, params);
    await query(`RELEASE SAVEPOINT ${savepoint}`);
    return result.rows;
  } catch (error) {
    await query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await query(`RELEASE SAVEPOINT ${savepoint}`);
    dump.checks.push({
      level: "ERROR",
      message: `Query failed for ${section}`,
      details: {
        code: error?.code ?? null,
        message: error?.message ?? String(error),
      },
    });
    return [];
  }
}

try {
  await client.connect();
  await query("BEGIN READ ONLY");
  await query("SET LOCAL statement_timeout = '30s'");

  const shopRows = await safeQuery(
    "commerce.Shop",
    `SELECT *
       FROM commerce."Shop"
      WHERE lower(domain) = lower($1)`,
    [shopDomain],
  );

  if (shopRows.length === 0) {
    console.error(`No commerce.Shop row found for: ${shopDomain}`);
    await query("ROLLBACK");
    process.exitCode = 1;
  } else {
    const shop = shopRows[0];
    const shopId = shop.id;
    dump.anchor.shop = shop;

    dump.anchor.shopSettings = (
      await safeQuery(
        "shopify.ShopSettings",
        `SELECT * FROM shopify."ShopSettings" WHERE "shopId" = $1`,
        [shopId],
      )
    )[0] ?? null;

    // Deliberately omit OAuth accessToken / refreshToken.
    dump.anchor.sessions = await safeQuery(
      "shopify.Session",
      `SELECT id, shop, state, "isOnline", scope, expires,
              "userId", "firstName", "lastName", email,
              "accountOwner", locale, collaborator, "emailVerified",
              "refreshTokenExpires"
         FROM shopify."Session"
        WHERE lower(shop) = lower($1)
        ORDER BY id`,
      [shopDomain],
    );

    // Discover every billing table directly scoped by shopId.
    const billingTableMeta = await safeQuery(
      "billing information_schema",
      `SELECT table_name,
              array_agg(column_name ORDER BY ordinal_position) AS columns
         FROM information_schema.columns
        WHERE table_schema = 'billing'
        GROUP BY table_name
       HAVING bool_or(column_name = 'shopId')
        ORDER BY table_name`,
    );

    for (const meta of billingTableMeta) {
      const tableName = meta.table_name;
      const columns = meta.columns ?? [];
      const orderParts = [];

      if (columns.includes("createdAt")) orderParts.push(quoteIdent("createdAt"));
      if (columns.includes("periodStart")) orderParts.push(quoteIdent("periodStart"));
      if (columns.includes("id")) orderParts.push(quoteIdent("id"));

      const orderBy = orderParts.length > 0 ? ` ORDER BY ${orderParts.join(", ")}` : "";
      const sql = `SELECT * FROM billing.${quoteIdent(tableName)} WHERE ${quoteIdent("shopId")} = $1${orderBy}`;
      dump.billing[tableName] = await safeQuery(`billing.${tableName}`, sql, [shopId]);
    }

    dump.catalog.billingPlans = await safeQuery(
      "billing.BillingPlan",
      `SELECT * FROM billing."BillingPlan" ORDER BY "shopifyPlanHandle"`,
    );

    dump.catalog.billingPlanFeatures = await safeQuery(
      "billing.BillingPlanFeature",
      `SELECT f.*, p."shopifyPlanHandle", p.name AS "planName"
         FROM billing."BillingPlanFeature" f
         JOIN billing."BillingPlan" p ON p.id = f."planId"
        ORDER BY p."shopifyPlanHandle", f.feature`,
    );

    dump.catalog.upgradeEconomicsEdges = await safeQuery(
      "billing.BillingUpgradeEconomicsEdge",
      `SELECT e.*,
              lp."shopifyPlanHandle" AS "lowerPlanHandle",
              hp."shopifyPlanHandle" AS "higherPlanHandle"
         FROM billing."BillingUpgradeEconomicsEdge" e
         JOIN billing."BillingPlan" lp ON lp.id = e."lowerPlanId"
         JOIN billing."BillingPlan" hp ON hp.id = e."higherPlanId"
        ORDER BY "lowerPlanHandle", "higherPlanHandle"`,
    );

    dump.catalog.economicsSnapshots = await safeQuery(
      "billing.BillingEconomicsSnapshot",
      `SELECT s.*, p."shopifyPlanHandle" AS "currentPlanHandle"
         FROM billing."BillingEconomicsSnapshot" s
         JOIN billing."BillingPlan" p ON p.id = s."billingPlanId"
        ORDER BY s."verifiedAt", s.id`,
    );

    dump.catalog.platformBillingPolicy = await safeQuery(
      "billing.PlatformBillingPolicy",
      `SELECT * FROM billing."PlatformBillingPolicy" ORDER BY id`,
    );

    dump.promotions.campaigns = await safeQuery(
      "billing.PromotionCampaign",
      `SELECT DISTINCT pc.*
         FROM billing."PromotionCampaign" pc
         LEFT JOIN billing."PromotionalCreditGrant" g
           ON g."campaignId" = pc.id AND g."shopId" = $1
         LEFT JOIN billing."MerchantPromotionSelection" s
           ON s."shopId" = $1
         LEFT JOIN billing."PromotionalCreditGrant" sg
           ON sg.id = s."promotionalCreditGrantId"
        WHERE pc."targetShopId" = $1
           OR g.id IS NOT NULL
           OR sg."campaignId" = pc.id
        ORDER BY pc."createdAt", pc.id`,
      [shopId],
    );

    const campaignIds = dump.promotions.campaigns.map((row) => row.id);
    dump.promotions.campaignEvents = campaignIds.length > 0
      ? await safeQuery(
          "billing.PromotionCampaignEvent",
          `SELECT *
             FROM billing."PromotionCampaignEvent"
            WHERE "campaignId" = ANY($1::text[])
            ORDER BY "createdAt", id`,
          [campaignIds],
        )
      : [];

    const subscriptions = dump.billing.Subscription ?? [];
    const periods = dump.billing.BillingPeriod ?? [];
    const periodCounters = dump.billing.BillingPeriodEntitlementCounter ?? [];
    const shopCounters = dump.billing.ShopEntitlementCounter ?? [];
    const purchases = dump.billing.RecoveryCreditPurchase ?? [];
    const usageEvents = dump.billing.UsageEvent ?? [];

    if (subscriptions.length === 0) {
      addCheck(dump.checks, "WARN", "No billing.Subscription row exists for this shop.");
    } else if (subscriptions.length > 1) {
      addCheck(dump.checks, "ERROR", "More than one billing.Subscription row exists for a shopId that should be unique.", {
        count: subscriptions.length,
      });
    } else {
      const subscription = subscriptions[0];
      const currentPlan = dump.catalog.billingPlans.find((p) => p.id === subscription.planId);

      if (subscription.planId && !currentPlan) {
        addCheck(dump.checks, "ERROR", "Subscription.planId does not resolve to BillingPlan.", {
          planId: subscription.planId,
        });
      }

      if (
        subscription.observedShopifyPlanHandle &&
        currentPlan?.shopifyPlanHandle &&
        subscription.observedShopifyPlanHandle !== currentPlan.shopifyPlanHandle
      ) {
        addCheck(dump.checks, "WARN", "Observed Shopify plan handle differs from the mapped current BillingPlan handle.", {
          observedShopifyPlanHandle: subscription.observedShopifyPlanHandle,
          mappedShopifyPlanHandle: currentPlan.shopifyPlanHandle,
          pendingShopifyPlanHandle: subscription.pendingShopifyPlanHandle,
        });
      }

      if (subscription.billingPeriodId) {
        const currentPeriod = periods.find((p) => p.id === subscription.billingPeriodId);
        if (!currentPeriod) {
          addCheck(dump.checks, "ERROR", "Subscription.billingPeriodId does not resolve to a BillingPeriod.", {
            billingPeriodId: subscription.billingPeriodId,
          });
        }
      }
    }

    const openPeriods = periods.filter((p) => p.status === "OPEN");
    if (openPeriods.length > 1) {
      addCheck(dump.checks, "ERROR", "More than one OPEN BillingPeriod exists for this shop.", {
        billingPeriodIds: openPeriods.map((p) => p.id),
      });
    }

    for (const counter of shopCounters) {
      const available =
        Number(counter.grantedQuantity ?? 0) -
        Number(counter.committedQuantity ?? 0) -
        Number(counter.reservedQuantity ?? 0) -
        Number(counter.refundingQuantity ?? 0);

      counter.__derivedAvailableQuantity = available;
      if (available < 0) {
        addCheck(dump.checks, "ERROR", "ShopEntitlementCounter derived available quantity is negative.", {
          counter: counter.counter,
          available,
        });
      }
    }

    for (const counter of periodCounters) {
      const available =
        Number(counter.grantedQuantity ?? 0) -
        Number(counter.committedQuantity ?? 0) -
        Number(counter.reservedQuantity ?? 0) -
        Number(counter.forfeitedQuantity ?? 0);

      counter.__derivedAvailableQuantity = available;
      if (available < 0) {
        addCheck(dump.checks, "ERROR", "BillingPeriodEntitlementCounter derived available quantity is negative.", {
          billingPeriodId: counter.billingPeriodId,
          counter: counter.counter,
          available,
        });
      }
    }

    for (const purchase of purchases) {
      const available = Number(purchase.currentAmount ?? 0) - Number(purchase.reservedAmount ?? 0);
      purchase.__derivedAvailableAmount = available;

      if (available < 0) {
        addCheck(dump.checks, "ERROR", "RecoveryCreditPurchase availableAmount is negative.", {
          purchaseId: purchase.id,
          currentAmount: purchase.currentAmount,
          reservedAmount: purchase.reservedAmount,
        });
      }

      if (purchase.status === "ACTIVE") {
        if (!purchase.providerValuationConfirmedAt || purchase.providerPurchaseAmount == null || !purchase.providerPurchaseCurrency) {
          addCheck(dump.checks, "ERROR", "ACTIVE RecoveryCreditPurchase is missing provider valuation evidence.", {
            purchaseId: purchase.id,
          });
        }
      }

      if (["COMPLETED", "REFUNDED"].includes(purchase.status)) {
        if (Number(purchase.currentAmount ?? 0) !== 0 || Number(purchase.reservedAmount ?? 0) !== 0) {
          addCheck(dump.checks, "ERROR", `${purchase.status} RecoveryCreditPurchase has a non-zero balance.`, {
            purchaseId: purchase.id,
            currentAmount: purchase.currentAmount,
            reservedAmount: purchase.reservedAmount,
          });
        }
      }
    }

    const attentionEvents = usageEvents.filter((event) =>
      ["RETRYABLE", "NEEDS_ATTENTION"].includes(event.shopifyReportState),
    );
    if (attentionEvents.length > 0) {
      addCheck(dump.checks, "WARN", "UsageEvents require Shopify reporting/reconciliation attention.", {
        count: attentionEvents.length,
        usageEventIds: attentionEvents.map((event) => event.id),
      });
    }

    // End the DB transaction before making the network call. Everything above is read-only.
    await query("ROLLBACK");

    if (noShopify) {
      dump.shopifyPartner = {
        status: "SKIPPED",
        reason: "--no-shopify supplied",
        apiVersion: PARTNER_API_VERSION,
        activeSubscription: null,
        latestLifecycleEvent: null,
      };
    } else {
      try {
        dump.shopifyPartner = await fetchPartnerBillingSnapshot(shop.shopifyShopId);
        if (dump.shopifyPartner.status === "SKIPPED") {
          addCheck(dump.checks, "WARN", `Shopify Partner API comparison skipped: ${dump.shopifyPartner.reason}`);
        }
      } catch (error) {
        dump.shopifyPartner = {
          status: "ERROR",
          apiVersion: PARTNER_API_VERSION,
          error: error?.message ?? String(error),
          activeSubscription: null,
          latestLifecycleEvent: null,
        };
        addCheck(dump.checks, "ERROR", "Shopify Partner API inspection failed.", {
          message: error?.message ?? String(error),
        });
      }
    }

    dump.comparison = buildShopifyComparison(dump);

    if (jsonOnly) {
      console.log(json(dump));
    } else {
      heading("MODA INTERACT BILLING INSPECTOR");
      console.log(json({
        inspectedAt: dump.inspectedAt,
        shopDomain,
        shopId,
        shopifyShopId: shop.shopifyShopId ?? null,
        database: dump.database,
        partnerApiVersion: PARTNER_API_VERSION,
        partnerApiStatus: dump.shopifyPartner?.status ?? "NOT_RUN",
      }));

      printRows("commerce.Shop", [dump.anchor.shop]);
      printRows("shopify.ShopSettings", dump.anchor.shopSettings ? [dump.anchor.shopSettings] : []);
      printRows("shopify.Session (OAuth secrets omitted)", dump.anchor.sessions);

      for (const [tableName, rows] of Object.entries(dump.billing).sort(([a], [b]) => a.localeCompare(b))) {
        printRows(`billing.${tableName}`, rows);
      }

      printRows("billing.BillingPlan (catalog)", dump.catalog.billingPlans);
      printRows("billing.BillingPlanFeature (catalog)", dump.catalog.billingPlanFeatures);
      printRows("billing.BillingUpgradeEconomicsEdge (catalog)", dump.catalog.upgradeEconomicsEdges);
      printRows("billing.BillingEconomicsSnapshot (catalog)", dump.catalog.economicsSnapshots);
      printRows("billing.PlatformBillingPolicy", dump.catalog.platformBillingPolicy);
      printRows("billing.PromotionCampaign (associated)", dump.promotions.campaigns);
      printRows("billing.PromotionCampaignEvent (associated)", dump.promotions.campaignEvents);

      heading(`SHOPIFY PARTNER API — ${dump.shopifyPartner?.status ?? "NOT_RUN"}`);
      console.log(json(dump.shopifyPartner));

      heading(`LOCAL ↔ SHOPIFY COMPARISON (${dump.comparison.length})`);
      console.log(dump.comparison.length === 0 ? "[]" : json(dump.comparison));

      const errorCount = dump.checks.filter((check) => check.level === "ERROR").length;
      const warnCount = dump.checks.filter((check) => check.level === "WARN").length;
      heading(`CONSISTENCY CHECKS (${dump.checks.length}: ${errorCount} ERROR, ${warnCount} WARN)`);
      if (dump.checks.length === 0) {
        console.log("No obvious consistency problems detected by this read-only inspector.");
      } else {
        console.log(json(dump.checks));
      }
    }
  }
} catch (error) {
  try {
    await query("ROLLBACK");
  } catch {
    // Ignore rollback failure while surfacing original error.
  }
  console.error("Billing inspection failed:");
  console.error(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
