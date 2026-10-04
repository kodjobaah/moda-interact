import { spawn } from "node:child_process";

const PORT = 50620;
const NGROK_API = "http://127.0.0.1:4040/api/tunnels";

let ngrok;
let shopify;
let shuttingDown = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getNgrokUrl() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const response = await fetch(NGROK_API);

      if (response.ok) {
        const data = await response.json();

        const tunnel = data.tunnels?.find(
          (tunnel) =>
            typeof tunnel.public_url === "string" &&
            tunnel.public_url.startsWith("https://"),
        );

        if (tunnel) {
          return tunnel.public_url;
        }
      }
    } catch {
      // ngrok isn't ready yet
    }

    await sleep(500);
  }

  throw new Error("Timed out waiting for ngrok to start.");
}

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log("\nStopping Shopify and ngrok...");

  if (shopify && !shopify.killed) {
    shopify.kill("SIGTERM");
  }

  if (ngrok && !ngrok.killed) {
    ngrok.kill("SIGTERM");
  }

  setTimeout(() => {
    process.exit(exitCode);
  }, 250);
}

async function main() {
  console.log(`Starting ngrok on port ${PORT}...`);

  ngrok = spawn(
  "ngrok",
  ["http", String(PORT)],
  {
    // Keep ngrok running in the background without its terminal UI
    stdio: ["ignore", "ignore", "ignore"],
  },
);

  ngrok.on("error", (error) => {
    console.error("\nFailed to start ngrok:");
    console.error(error.message);

    if (error.code === "ENOENT") {
      console.error(
        "\nMake sure ngrok is installed and available on your PATH.",
      );
    }

    shutdown(1);
  });

  ngrok.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `\nngrok exited unexpectedly (${signal ?? code ?? "unknown"}).`,
      );

      shutdown(code ?? 1);
    }
  });

  console.log("Waiting for ngrok...");

  const ngrokUrl = await getNgrokUrl();

  const tunnelUrl = `${ngrokUrl}:${PORT}`;

  console.log(`
ngrok is ready:

  ${ngrokUrl}

Starting Shopify:

  npx shopify app dev --tunnel-url=${tunnelUrl}
`);

  shopify = spawn(
  "npx",
  [
    "shopify",
    "app",
    "dev",
    "--tunnel-url",
    tunnelUrl,
  ],
  {
    stdio: "inherit",
  },
);
  shopify.on("error", (error) => {
    console.error("\nFailed to start Shopify:");
    console.error(error.message);
    shutdown(1);
  });

  shopify.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.log(
        `\nShopify exited (${signal ?? code ?? 0}).`,
      );

      shutdown(code ?? 0);
    }
  });
}

process.on("SIGINT", () => {
  shutdown(0);
});

process.on("SIGTERM", () => {
  shutdown(0);
});

process.on("uncaughtException", (error) => {
  console.error(error);
  shutdown(1);
});

process.on("unhandledRejection", (error) => {
  console.error(error);
  shutdown(1);
});

main().catch((error) => {
  console.error(`\n${error.message}`);
  shutdown(1);
});
