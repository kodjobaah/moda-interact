import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function applicationSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? applicationSourceFiles(path) : [path];
  });
}

describe("shared observability runtime ownership", () => {
  it("initializes the published runtime with the Shopify service profile", () => {
    const script = `
      await import("./observability.mjs");
      const { getNodeObservabilityRuntime } = await import(
        "@modainteract/moda-interact-shared/observability/node"
      );
      const runtime = getNodeObservabilityRuntime();
      process.stdout.write(JSON.stringify(runtime));
      await runtime.shutdown();
    `;
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "--eval", script],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DEPLOYMENT_ENVIRONMENT_NAME: "test",
          OTEL_SDK_DISABLED: "true",
        },
        encoding: "utf8",
      },
    );

    expect(JSON.parse(output)).toMatchObject({
      enabled: false,
      serviceName: "moda-interact",
      environment: "test",
    });
  });

  it("keeps generic provider and exporter ownership out of application code", () => {
    const source = applicationSourceFiles(resolve(repoRoot, "app"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /NodeSDK|TracerProvider|MeterProvider|OTLPTraceExporter|OTLPMetricExporter|BatchSpanProcessor/,
    );
    expect(source).not.toMatch(
      /@opentelemetry\/(sdk-|exporter-|instrumentation-|context-async-hooks)/,
    );
  });
});