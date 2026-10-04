import { spawn } from "node:child_process";

const PORT = 50620;
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";

async function getNgrokUrl() {
  let response;

  try {
    response = await fetch(NGROK_API);
  } catch {
    console.error(`
❌ Cannot connect to ngrok.

Start ngrok first in another terminal:

  npm run shopify:ngrok
`);
    process.exit(1);
  }

  if (!response.ok) {
    throw new Error(
      `ngrok API returned ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();

  const tunnel = data.tunnels?.find(
    (tunnel) =>
      typeof tunnel.public_url === "string" &&
      tunnel.public_url.startsWith("https://"),
  );

  if (!tunnel) {
    console.error(`
❌ No HTTPS ngrok tunnel found.

Start ngrok first:

  npm run shopify:ngrok
`);
    process.exit(1);
  }

  return tunnel.public_url;
}

const ngrokUrl = await getNgrokUrl();

const shopifyTunnelUrl = `${ngrokUrl}:${PORT}`;

console.log(`
Ngrok tunnel detected:
  ${ngrokUrl}

Starting Shopify with:
  --tunnel-url=${shopifyTunnelUrl}
`);

const child = spawn(
  "npx",
  [
    "shopify",
    "app",
    "dev",
    "--tunnel-url",
    shopifyTunnelUrl,
  ],
  {
    stdio: "inherit",
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
