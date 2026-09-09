import { fileURLToPath, URL } from "node:url";

import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(
        new URL("./app", import.meta.url),
      ),
    },
  },

  plugins: [
    tsconfigPaths(),
  ],

  test: {
    server: {
      deps: {
        inline: [/@opentelemetry/],
      },
    },
  },
});