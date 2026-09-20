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
          "fixedShopifyDiscountId",
          "followUpEnabled",
          "followUpDelayMinutes",
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
    const settings = await saveMerchantRecoveryPolicy(
      shop.id,
      {
        recoveryDelayMinutes: form.get("recoveryDelayMinutes"),
        recoveryOfferMode: form.get("recoveryOfferMode"),
        fixedShopifyDiscountId:
          form.get("recoveryOfferMode") === "FIXED"
            ? form.get("fixedShopifyDiscountId")
            : null,
        followUpEnabled: form.get("followUpEnabled"),
        followUpDelayMinutes: form.get("followUpDelayMinutes"),
      },
      new Date(),
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
    )
      return reply({ ok: false, error: "INVALID_INPUT" }, 400);
    throw error;
  }
}
