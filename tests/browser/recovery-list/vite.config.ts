import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: "/tmp/moda-arch019-shopify003-vite",
  esbuild: { jsx: "automatic" },
  server: {
    host: "127.0.0.1",
    port: 4179,
    strictPort: true,
    fs: {
      allow: [
        fileURLToPath(new URL("../../..", import.meta.url)),
        fileURLToPath(new URL("../../../node_modules", import.meta.url)),
      ],
    },
  },
});
