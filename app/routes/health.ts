/**
 * GET /health — process liveness.
 *
 * Reports that this process is alive. Intentionally makes no dependency
 * calls: liveness must not fail (or slow down) when Redis or PostgreSQL is
 * down. Dependency status is reported by GET /ready.
 */
export const loader = async () => {
  return Response.json(
    { status: "ok" },
    {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    },
  );
};
