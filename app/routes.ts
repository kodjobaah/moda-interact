import {
  type RouteConfig,
  index,
  route,
} from "@react-router/dev/routes";

/**
 * Explicit route ownership for Moda Interact.
 *
 * - Embedded UI pages under /app are children of the App layout.
 * - Transition/resource endpoints that must not execute App/Billing UI parent
 *   loaders are independent top-level routes.
 * - Webhooks and health endpoints are independent resource routes.
 */
export default [
  index("./routes/public/home/route.jsx"),
  route("privacy", "./routes/public/privacy/route.tsx"),

  route("health", "./routes/system/health/route.ts"),
  route("ready", "./routes/system/ready/route.ts"),
  route("telemetry-probe", "./routes/system/telemetry-probe/route.ts"),

  route("auth/login", "./routes/auth/login/route.jsx"),
  route("auth/*", "./routes/auth/catchall/route.jsx"),

  route("app", "./routes/app/route.jsx", [
    index("./routes/app/home/route.jsx"),
    route("additional", "./routes/app/additional/route.jsx"),
    route("billing", "./routes/app/billing/route.tsx"),
    route("merchant-support", "./routes/app/merchant-support/route.jsx"),
    route("usage", "./routes/app/usage/route.jsx"),
  ]),

  route("app/billing/select", "./routes/app/billing/select/route.jsx"),
  route("app/billing/callback", "./routes/app/billing/callback/route.tsx"),
  route("app/billing/options", "./routes/app/billing/options/route.tsx"),
  route("app/pending-recoveries", "./routes/app/pending-recoveries/route.jsx"),

  route("webhooks", "./routes/webhooks/root/route.jsx"),
  route("webhooks/app/scopes_update", "./routes/webhooks/app/scopes-update/route.jsx"),
  route("webhooks/app/uninstalled", "./routes/webhooks/app/uninstalled/route.jsx"),
  route("webhooks/customers/data_request", "./routes/webhooks/customers/data-request/route.jsx"),
  route("webhooks/customers/redact", "./routes/webhooks/customers/redact/route.jsx"),
  route("webhooks/shop/redact", "./routes/webhooks/shop/redact/route.jsx"),
] satisfies RouteConfig;
