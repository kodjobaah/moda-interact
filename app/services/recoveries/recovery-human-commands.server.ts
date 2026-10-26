import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createLogger } from "@modainteract/moda-interact-shared/logging";
import prisma from "../../db.server";
import { configuredFollowUpIsDue, customerServiceWindow } from "./recovery-service-window";
import { readCurrentFollowUpTemplates } from "./recovery-follow-up-catalogue.server";

const logger = createLogger({ serviceName: "moda-interact", environment: process.env.NODE_ENV ?? "development" });
const terminal = new Set(["COMPLETED", "CANCELLED", "EXPIRED"]);

export type CurrentControl = { controlMode: "AI" | "HUMAN"; controlRevision: number };
export class RecoveryCommandError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
    public readonly currentControl?: CurrentControl,
  ) {
    super(code);
    this.name = "RecoveryCommandError";
  }
}
const refused = (code: string, status = 409, currentControl?: CurrentControl): never => {
  throw new RecoveryCommandError(code, status, currentControl);
};

type Context = {
  shopId: string;
  recovery: { id: string; status: string; customerId: string | null };
  conversation: { id: string; controlMode: "AI" | "HUMAN"; controlRevision: number; languageTag: string | null };
};

/** DATABASE-001 ordering contract: Shop -> Conversation -> command / outreach attempt.
 * Every command originates from a trusted Shopify session shopId, never from submitted JSON.
 */
async function lockedContext(tx: Prisma.TransactionClient, shopId: string, recoveryId: string): Promise<Context> {
  const owned = await tx.checkoutRecovery.findFirst({
    where: { id: recoveryId, shopId },
    select: { id: true, status: true, customerId: true },
  });
  if (!owned) return refused("not_found", 404);
  const shop = await tx.$queryRaw<{ id: string; status: string }[]>(Prisma.sql`
    SELECT "id", "status"::text FROM "commerce"."Shop"
    WHERE "id"=${shopId} FOR UPDATE`);
  if (!shop.length) return refused("not_found", 404);
  const matching = await tx.$queryRaw<{ id: string; controlMode: "AI" | "HUMAN"; controlRevision: number; languageTag: string | null }[]>(Prisma.sql`
    SELECT "id", "controlMode"::text, "controlRevision", "languageTag" FROM "whatsapp"."Conversation"
    WHERE "checkoutRecoveryId"=${owned.id} AND "type"='RECOVERY'
      AND ("shopId" IS NULL OR "shopId"=${shopId}) FOR UPDATE`);
  const conversation = matching[0];
  if (!conversation) return refused("not_found", 404);
  return { shopId, recovery: owned, conversation };
}

async function assertMerchantEnabled(tx: Prisma.TransactionClient, shopId: string) {
  // RECOVERY_HISTORY is a history permission, not an outbound messaging entitlement.
  // Recheck operational plan + recovery Feature under the Shop lock on each mutation.
  const shop = await tx.shop.findUnique({ where: { id: shopId }, select: { status: true } });
  if (shop?.status !== "ACTIVE") return refused("human_messaging_unavailable", 403);
  const subscription = await tx.subscription.findUnique({
    where: { shopId },
    select: { status: true, plan: { select: { active: true, features: {
      where: { enabled: true, feature: { key: "checkout_recovery", active: true } },
      select: { featureId: true }, take: 1,
    } } } },
  });
  if (!subscription || !["ACTIVE", "TRIALING"].includes(subscription.status) ||
      !subscription.plan?.active || !subscription.plan.features.length) {
    return refused("human_messaging_unavailable", 403);
  }
}

async function assertRestriction(tx: Prisma.TransactionClient, shopId: string) {
  const state = await tx.shopHumanMessagingRestriction.findUnique({
    where: { shopId }, select: { status: true },
  });
  if (state?.status === "SUSPENDED") return refused("human_messaging_suspended", 403);
}

export type ControlInput = { expectedControlRevision: number; targetMode: "AI" | "HUMAN" };
export async function changeRecoveryControl(
  shopId: string, recoveryId: string, input: ControlInput, db: PrismaClient = prisma,
) {
  if (!Number.isSafeInteger(input.expectedControlRevision) || input.expectedControlRevision < 0 ||
      !["AI", "HUMAN"].includes(input.targetMode)) return refused("invalid_request", 400);
  const result = await db.$transaction(async (tx) => {
    const context = await lockedContext(tx, shopId, recoveryId);
    if (input.targetMode === "HUMAN") {
      if (terminal.has(context.recovery.status)) return refused("terminal_recovery");
      await assertMerchantEnabled(tx, shopId);
      await assertRestriction(tx, shopId);
    }
    const current = context.conversation;
    if (current.controlRevision !== input.expectedControlRevision) return refused("stale_control_revision", 409, {
      controlMode: current.controlMode, controlRevision: current.controlRevision,
    });
    if (current.controlMode === input.targetMode) return refused("control_already_selected");
    const update = await tx.conversation.updateMany({
      where: { id: current.id, controlRevision: current.controlRevision, controlMode: current.controlMode },
      data: { controlMode: input.targetMode, controlRevision: { increment: 1 }, controlChangedAt: new Date() },
    });
    if (update.count !== 1) return refused("stale_control_revision");
    await tx.conversationControlEvent.create({
      data: { conversationId: current.id, fromMode: current.controlMode, toMode: input.targetMode,
        fromRevision: current.controlRevision, toRevision: current.controlRevision + 1 },
    });
    return { controlMode: input.targetMode, controlRevision: current.controlRevision + 1 };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  logger.info("shopify.recovery.human_control_changed", { recoveryId, mode: result.controlMode });
  return result;
}

export type SendInput =
  | { kind: "HUMAN_TEXT"; expectedControlRevision: number; idempotencyKey: string; textBody: string }
  | { kind: "RECOVERY_FOLLOW_UP_TEMPLATE"; expectedControlRevision: number; idempotencyKey: string; templateVariantId: string };

/** Reject the same C0 control characters as the original validation rule.
 * TAB, LF and CR remain valid human-message whitespace.
 */
function hasForbiddenControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit <= 0x1f && codeUnit !== 0x09 && codeUnit !== 0x0a && codeUnit !== 0x0d) return true;
  }
  return false;
}

function validateSend(input: SendInput) {
  if (!Number.isSafeInteger(input.expectedControlRevision) || input.expectedControlRevision < 0 ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(input.idempotencyKey)) return refused("invalid_request", 400);
  if (input.kind === "HUMAN_TEXT") {
    if (typeof input.textBody !== "string" || !input.textBody.trim() ||
        input.textBody.length > 4000 || hasForbiddenControlCharacter(input.textBody)) {
      return refused("invalid_request", 400);
    }
  } else if (input.kind === "RECOVERY_FOLLOW_UP_TEMPLATE") {
    if (typeof input.templateVariantId !== "string" || !/^[\w-]{1,255}$/.test(input.templateVariantId)) {
      return refused("invalid_request", 400);
    }
  } else return refused("invalid_request", 400);
}

/** Stable identity is computed from the merchant's normalized immutable request.
 * Replays work after a mode change or receipt update; a changed payload cannot reuse a key.
 */
export function humanSendPayloadHash(conversationId: string, input: SendInput) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 1, conversationId, kind: input.kind,
    expectedControlRevision: input.expectedControlRevision,
    ...(input.kind === "HUMAN_TEXT" ? { textBody: input.textBody.trim() } : { templateVariantId: input.templateVariantId }),
  })).digest("hex");
}

export async function admitRecoveryHumanSend(
  shopId: string, recoveryId: string, input: SendInput, db: PrismaClient = prisma,
) {
  validateSend(input);
  const result = await db.$transaction(async (tx) => {
    const context = await lockedContext(tx, shopId, recoveryId);
    const { conversation } = context;
    const digest = humanSendPayloadHash(conversation.id, input);
    const existing = await tx.merchantConversationSendCommand.findUnique({
      where: { shopId_idempotencyKey: { shopId, idempotencyKey: input.idempotencyKey } },
      select: { id: true, conversationId: true, payloadSha256: true, state: true, kind: true },
    });
    if (existing) {
      if (existing.conversationId !== conversation.id || existing.payloadSha256 !== digest) return refused("idempotency_conflict");
      return { commandId: existing.id, conversationId: conversation.id, state: existing.state, kind: existing.kind,
        controlRevision: input.expectedControlRevision, replay: true };
    }
    // Freeze eligibility time once, after replay lookup and under the shop/conversation locks.
    const now = new Date();
    if (terminal.has(context.recovery.status)) return refused("terminal_recovery");
    await assertMerchantEnabled(tx, shopId);
    await assertRestriction(tx, shopId);
    if (conversation.controlRevision !== input.expectedControlRevision) return refused("stale_control_revision", 409, {
      controlMode: conversation.controlMode, controlRevision: conversation.controlRevision,
    });
    if (conversation.controlMode !== "HUMAN") return refused("not_human_controlled");
    const initial = await tx.recoveryOutreachAttempt.findUnique({
      where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: recoveryId, sequence: 1 } },
      select: { id: true, recipient: true, sentAt: true, followUpDueAt: true, configuredOfferMode: true,
        fixedShopifyDiscountId: true, offerSnapshot: true },
    });
    if (!initial?.recipient || !/^\+?[0-9]{7,20}$/.test(initial.recipient)) return refused("recipient_unavailable");
    const suppress = await tx.whatsAppRecipientReachability.findUnique({
      where: { shopId_recipient: { shopId, recipient: initial.recipient } },
      select: { suppressUntil: true },
    });
    if (suppress?.suppressUntil && suppress.suppressUntil > now) return refused("recipient_unavailable");
    const inbound = initial.sentAt ? await tx.conversationMessage.findFirst({
      where: { conversationId: conversation.id, direction: "INBOUND", senderType: "CUSTOMER",
        providerMessageId: { not: null }, createdAt: { gte: initial.sentAt, lte: now } },
      select: { createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }) : null;
    const windowOpen = customerServiceWindow(initial.sentAt, inbound?.createdAt, now).open;
    let attemptId: string | null = null;
    let template: { providerTemplateName: string; providerLanguageCode: string } | null = null;
    if (input.kind === "HUMAN_TEXT") {
      if (!windowOpen) return refused("service_window_closed");
    } else {
      if (windowOpen || !configuredFollowUpIsDue(initial.sentAt, initial.followUpDueAt, now)) {
        return refused("follow_up_unavailable");
      }
      // Re-read the current Moda-only catalogue under the same transaction as
      // sequence-two admission. A browser variant ID cannot select Meta identity.
      const catalogue = await readCurrentFollowUpTemplates(shopId, conversation.languageTag, tx);
      const chosen = catalogue.find((candidate) => candidate.id === input.templateVariantId);
      if (!chosen) return refused("template_not_allowed");
      template = { providerTemplateName: chosen.name, providerLanguageCode: chosen.providerLanguageCode };
      // Sequence 2 is shared with existing scheduled recovery follow-up. This
      // claim is committed atomically with the command; no provider work runs here.
      let follow = await tx.recoveryOutreachAttempt.findUnique({
        where: { checkoutRecoveryId_sequence: { checkoutRecoveryId: recoveryId, sequence: 2 } },
        select: { id: true, status: true, initiationKey: true, claimedAt: true, outboundMessageId: true },
      });
      if (!follow) {
        const created = await tx.recoveryOutreachAttempt.create({
          data: { checkoutRecoveryId: recoveryId, sequence: 2, recipient: initial.recipient,
            trigger: "POST_WINDOW_FOLLOW_UP", status: "PENDING",
            configuredOfferMode: initial.configuredOfferMode,
            fixedShopifyDiscountId: initial.fixedShopifyDiscountId,
            offerSnapshot: initial.offerSnapshot === null ? Prisma.JsonNull : initial.offerSnapshot as Prisma.InputJsonValue },
          select: { id: true },
        });
        follow = { id: created.id, status: "PENDING", initiationKey: null, claimedAt: null, outboundMessageId: null };
      }
      if (follow.status !== "PENDING" || follow.initiationKey || follow.claimedAt || follow.outboundMessageId) {
        return refused("follow_up_unavailable");
      }
      const claimed = await tx.recoveryOutreachAttempt.updateMany({
        where: { id: follow.id, status: "PENDING", initiationKey: null, claimedAt: null, outboundMessageId: null },
        data: { initiatedBy: "HUMAN", initiationKey: input.idempotencyKey,
          claimedAt: now, trigger: "POST_WINDOW_FOLLOW_UP" },
      });
      if (claimed.count !== 1) return refused("follow_up_unavailable");
      attemptId = follow.id;
    }
    const command = await tx.merchantConversationSendCommand.create({
      data: {
        shopId, conversationId: conversation.id, idempotencyKey: input.idempotencyKey, payloadSha256: digest,
        expectedControlRevision: input.expectedControlRevision, kind: input.kind,
        recipientSnapshot: initial.recipient,
        textBody: input.kind === "HUMAN_TEXT" ? input.textBody.trim() : null,
        templateName: template?.providerTemplateName ?? null,
        templateLanguageCode: template?.providerLanguageCode ?? null,
        // A HUMAN_TEXT command requires SQL NULL, not a JSON `null` value:
        // MerchantConversationSendCommand_payload_check uses IS NULL.
        templateParameters: template ? {} : Prisma.DbNull,
        recoveryOutreachAttemptId: attemptId,
      },
      select: { id: true, state: true, kind: true },
    });
    return { commandId: command.id, conversationId: conversation.id, state: command.state, kind: command.kind,
      controlRevision: conversation.controlRevision, replay: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  logger.info("shopify.recovery.human_command_accepted", {
    recoveryId, kind: result.kind, replay: result.replay,
  });
  return result;
}

export async function readRecoveryCommandStatus(
  shopId: string, recoveryId: string, commandId: string, db: PrismaClient = prisma,
) {
  const found = await db.merchantConversationSendCommand.findFirst({
    where: { id: commandId, shopId, conversation: { type: "RECOVERY", checkoutRecovery: { id: recoveryId, shopId } } },
    select: { id: true, conversationId: true, kind: true, state: true, createdAt: true, updatedAt: true,
      nextAttemptAt: true, outboundMessageId: true, failureCode: true,
      outboundMessage: { select: { status: true } },
      moderationAssessments: {
        orderBy: { createdAt: "desc" }, take: 1,
        select: { decision: true },
      },
    },
  });
  if (!found) return refused("not_found", 404);
  return {
    schemaVersion: 1, commandId: found.id, conversationId: found.conversationId,
    kind: found.kind, state: found.state, createdAt: found.createdAt.toISOString(),
    updatedAt: found.updatedAt.toISOString(), nextAttemptAt: found.nextAttemptAt?.toISOString() ?? null,
    messageId: found.outboundMessageId,
    providerStatus: found.outboundMessage?.status ?? null,
    // Only persistently classified reasons; no provider body, score or admin notes.
    failureCode: found.failureCode, moderation: found.moderationAssessments[0]?.decision ?? "PENDING",
  };
}
