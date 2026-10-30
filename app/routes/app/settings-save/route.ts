import type { ActionFunctionArgs } from "react-router";
import { settingsAccess } from "@/services/feature-preferences/access.server";
import {
  PreferenceError,
  saveFeaturePreferences,
} from "@/services/feature-preferences/feature-preferences.server";
import {
  RecoveryPolicyValidationError,
  saveMerchantRecoveryPolicy,
} from "@/services/recovery-policy/recovery-policy.server";
import { ZodError } from "zod";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import { resolveDeploymentEnvironmentName } from "@/services/otel/otel.runtime";

const logger = createLogger({
  serviceName: "moda-interact",
  environment: resolveDeploymentEnvironmentName(),
});
export async function action({ request }: ActionFunctionArgs) {
  const { shop } = await settingsAccess(request);
  const form = await request.formData();
  const operationId = String(form.get("operationId") ?? "");
  const reply = (value: object, status = 200) =>
    Response.json(
      { ...value, operationId },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  const intent = form.get("intent");
  const allowed = new Set([
    "operationId",
    "intent",
    "revision",
    ...(intent === "features"
      ? ["preferences"]
      : [
          "recoveryDelayMinutes",
          "recoveryOfferMode",
          "selectedDiscountIds",
          "followUpEnabled",
          "followUpDelayMinutes",
          "notifyOnInitialRecoveryOutreach",
        ]),
  ]);
  if (
    !/^[a-zA-Z0-9-]{1,64}$/.test(operationId) ||
    !["features", "recovery"].includes(String(intent)) ||
    [...form.keys()].some((k) => !allowed.has(k) || form.getAll(k).length !== 1)
  )
    return reply({ ok: false, error: "INVALID_INPUT" }, 400);
  try {
    if (intent === "features") {
      const raw = form.get("preferences");
      if (typeof raw !== "string" || raw.length > 131072)
        return reply({ ok: false, error: "INVALID_INPUT" }, 400);
      let input: unknown;
      try {
        input = JSON.parse(raw);
      } catch {
        return reply({ ok: false, error: "INVALID_INPUT" }, 400);
      }
      const snapshot = await saveFeaturePreferences(
        shop.id,
        input,
        String(form.get("revision")),
      );
      return reply({ ok: true, revision: snapshot.revision });
    }
    const notifyOnInitialRecoveryOutreach = form.get("notifyOnInitialRecoveryOutreach");
    if (notifyOnInitialRecoveryOutreach !== "true" && notifyOnInitialRecoveryOutreach !== "false")
      return reply({ ok: false, error: "INVALID_INPUT" }, 400);
    const rawSelectedDiscountIds = form.get("selectedDiscountIds");
    if (
      typeof rawSelectedDiscountIds !== "string" ||
      new TextEncoder().encode(rawSelectedDiscountIds).byteLength > 8192
    ) return reply({ ok: false, error: "INVALID_INPUT" }, 400);
    let selectedDiscountIds: unknown;
    try {
      selectedDiscountIds = JSON.parse(rawSelectedDiscountIds);
    } catch {
      return reply({ ok: false, error: "INVALID_INPUT" }, 400);
    }
    if (!Array.isArray(selectedDiscountIds) || selectedDiscountIds.some(
      (id) => typeof id !== "string" || id.length === 0,
    ) || new Set(selectedDiscountIds).size !== selectedDiscountIds.length)
      return reply({ ok: false, error: "INVALID_INPUT" }, 400);
    if (selectedDiscountIds.length > 50)
      return reply({ ok: false, error: "TOO_MANY_DISCOUNTS" }, 422);
    if (form.get("recoveryOfferMode") === "FIXED" && selectedDiscountIds.length === 0)
      return reply({ ok: false, error: "FIXED_SELECTION_REQUIRED" }, 422);
    selectedDiscountIds.sort((left: string, right: string) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const settings = await saveMerchantRecoveryPolicy(
      shop.id,
      {
        recoveryDelayMinutes: form.get("recoveryDelayMinutes"),
        recoveryOfferMode: form.get("recoveryOfferMode"),
        selectedDiscountIds,
        followUpEnabled: form.get("followUpEnabled"),
        followUpDelayMinutes: form.get("followUpDelayMinutes"),
        notifyOnInitialRecoveryOutreach: notifyOnInitialRecoveryOutreach === "true",
      },
      String(form.get("revision")),
    );
    return reply({ ok: true, revision: settings.updatedAt.toISOString() });
  } catch (error) {
    if (error instanceof PreferenceError)
      return reply(
        { ok: false, error: error.message },
        error.message === "CONFLICT" ? 409 : 403,
      );
    if (
      error instanceof RecoveryPolicyValidationError ||
      error instanceof ZodError
    ) {
      if (
        error instanceof RecoveryPolicyValidationError &&
        ["TOO_MANY_DISCOUNTS", "FIXED_SELECTION_REQUIRED"].includes(error.code)
      ) return reply({ ok: false, error: error.code }, 422);
      return reply({ ok: false, error: "INVALID_INPUT" }, 400);
    }
    if (intent === "recovery") {
      logger.error("merchant.recovery_settings.save.failed", {
        shopId: shop.id,
        operation: "recovery_notice_preference",
        errorCategory: "persistence_failure",
        error,
      });
    }
    throw error;
  }
}
