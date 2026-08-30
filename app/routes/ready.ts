import { checkReadiness } from "../services/health/health-check.server";

/**
 * GET /ready — dependency readiness.
 *
 * Verifies that the dependencies required to safely handle application
 * requests are reachable:
 * - Redis (BullMQ queue publication for webhook ingress)
 * - PostgreSQL (session storage and shop/application data)
 *
 * Returns 200 only when every required dependency is ready, otherwise 503.
 * Checks are bounded and non-mutating. The body exposes only check names and
 * booleans — never credentials, connection strings or raw error text.
 */
export const loader = async () => {
  const result = await checkReadiness();
  const status = result.status === "ready" ? 200 : 503;

  return Response.json(
    { status: result.status, checks: result.checks },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
};
