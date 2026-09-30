import type { Config } from "@react-router/dev/config";

function resolveAllowedActionOrigins(): string[] | undefined {
  const candidates = [process.env.SHOPIFY_APP_URL, process.env.HOST];
  const hosts = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate) continue;

    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      hosts.add(url.host);
    } catch {
      // Ignore non-URL HOST values such as 0.0.0.0; same-origin requests do not
      // need an allow-list entry and React Router will keep enforcing its check.
    }
  }

  return hosts.size > 0 ? [...hosts] : undefined;
}

export default {
  // Shopify CLI terminates HTTPS at the development tunnel before forwarding the
  // request to the local React Router dev server. React Router 7.18 validates
  // action Origin against request.url; behind that proxy request.url can be http
  // while the browser Origin is the trusted https Shopify app URL. Allow only the
  // exact configured public app host instead of weakening CSRF protection with a
  // wildcard.
  allowedActionOrigins: resolveAllowedActionOrigins(),
  future: {
    unstable_optimizeDeps: true,
    v8_middleware: true,
    v8_splitRouteModules: true,
    v8_viteEnvironmentApi: true,
    v8_passThroughRequests: true,
    v8_trailingSlashAwareDataRequests: true,
  },
} satisfies Config;
