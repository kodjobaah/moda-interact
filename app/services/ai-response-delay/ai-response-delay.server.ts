import { AiResponseDelayMinutesSchema } from "@modainteract/moda-interact-shared/ai-response-delay";
import type { PrismaClient } from "@prisma/client";
import db from "@/db.server";
import {
  lockSettingsShop,
  PreferenceError,
} from "../feature-preferences/feature-preferences.server";

const FORM_MINUTES_PATTERN = /^(?:0|[1-9]|[12][0-9]|30)$/;

export class AiResponseDelayValidationError extends Error {
  constructor() {
    super("INVALID_INPUT");
  }
}

export function parseAiResponseDelayFormValue(value: unknown): number {
  if (typeof value !== "string" || !FORM_MINUTES_PATTERN.test(value))
    throw new AiResponseDelayValidationError();

  const parsed = AiResponseDelayMinutesSchema.safeParse(Number(value));
  if (!parsed.success) throw new AiResponseDelayValidationError();
  return parsed.data;
}

export async function saveAiResponseDelay(
  shopId: string,
  formValue: unknown,
  expectedRevision: string,
  client: PrismaClient = db,
) {
  const aiResponseDelayMinutes = parseAiResponseDelayFormValue(formValue);

  return client.$transaction(async (transaction) => {
    await lockSettingsShop(transaction, shopId);
    const current = await transaction.shopSettings.findUnique({
      where: { shopId },
      select: { aiResponseDelayMinutes: true, updatedAt: true },
    });
    if (!current) throw new PreferenceError("DENIED");
    if (expectedRevision !== current.updatedAt.toISOString())
      throw new PreferenceError("CONFLICT");

    if (current.aiResponseDelayMinutes === aiResponseDelayMinutes)
      return current;

    const updatedAt = new Date(
      Math.max(Date.now(), current.updatedAt.getTime() + 1),
    );
    return transaction.shopSettings.update({
      where: { shopId },
      data: { aiResponseDelayMinutes, updatedAt },
      select: { aiResponseDelayMinutes: true, updatedAt: true },
    });
  });
}
