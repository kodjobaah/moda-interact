import { spawn } from "node:child_process";

const PORT = 50620;
const CLOUDFLARED_URL_PATTERN = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/;

let cloudflared;
let shopify;
let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log("\nStopping Shopify and cloudflared...");

  if (shopify && !shopify.killed) {
    shopify.kill("SIGTERM");
  }

  if (cloudflared && !cloudflared.killed) {
    cloudflared.kill("SIGTERM");
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 250);
}

function startShopify(tunnelUrl) {
  console.log(`
Cloudflared tunnel detected:
  ${tunnelUrl}

Starting Shopify with:
  --tunnel-url=${tunnelUrl}
`);

  shopify = spawn(
    "npx",
    ["shopify", "app", "dev", "--tunnel-url", tunnelUrl],
    { stdio: "inherit" },
  );

  shopify.on("error", (error) => {
    console.error("\nFailed to start Shopify:");
    console.error(error.message);
    shutdown(1);
  });

  shopify.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.log(`\nShopify exited (${signal ?? code ?? 0}).`);
      shutdown(code ?? 0);
    }
  });
}

console.log(`Starting cloudflared on port ${PORT}...`);

cloudflared = spawn(
  "cloudflared",
  ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let output = "";
let tunnelStarted = false;

function handleOutput(chunk) {
  const text = chunk.toString();
  output += text;

  if (!tunnelStarted) {
    const tunnelMatch = output.match(CLOUDFLARED_URL_PATTERN);

    if (tunnelMatch) {
      tunnelStarted = true;
      startShopify(`${tunnelMatch[0]}:${PORT}`);
    }
  }

  process.stdout.write(text);
}

cloudflared.stdout.on("data", handleOutput);
cloudflared.stderr.on("data", handleOutput);

cloudflared.on("error", (error) => {
  console.error("\nFailed to start cloudflared:");
  console.error(error.message);

  if (error.code === "ENOENT") {
    console.error("\nMake sure cloudflared is installed and available on your PATH.");
  }

  shutdown(1);
});

cloudflared.on("exit", (code, signal) => {
  if (!shuttingDown) {
    console.error(
      `\ncloudflared exited unexpectedly (${signal ?? code ?? "unknown"}).`,
    );
    shutdown(code ?? 1);
  }
});

process.on("SIGINT", () => shutdown(130));
process.on("SIGTERM", () => shutdown(143));