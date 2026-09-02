import { defineConfig } from "vitest/config";

// The server build already bundles OpenTelemetry packages via
// `ssr.noExternal` in vite.config.js. Vitest needs the equivalent
// `server.deps.inline`, otherwise it externalizes @opentelemetry/* and Node's
// ESM loader chokes on the extensionless relative imports in
// @opentelemetry/api's ESM build, e.g.
// "Cannot find module .../build/esm/baggage/utils".
export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [/@opentelemetry/],
      },
    },
  },
});
