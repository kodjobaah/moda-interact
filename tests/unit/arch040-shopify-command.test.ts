import { describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
vi.mock("../../app/db.server", () => ({ default: {} }));
const { changeRecoveryControl, admitRecoveryHumanSend, humanSendPayloadHash } =
  await import("../../app/services/recoveries/recovery-human-commands.server");

function fixture(input?: { owned?: boolean; mode?: "AI" | "HUMAN"; revision?: number; suspended?: boolean;
  inbound?: boolean; existing?: boolean; secondClaimed?: boolean; templateApproved?: boolean }) {
  const options = { owned: true, mode: "HUMAN", revision: 1, suspended: false, inbound: true,
    existing: false, secondClaimed: false, templateApproved: true, ...input };
  const context = { id: "conversation-1", controlMode: options.mode, controlRevision: options.revision };
  const tx = {
    checkoutRecovery: { findFirst: vi.fn(async () => options.owned ? { id: "recovery-1", shopId: "shop-1", status: "ENGAGED", customerId: "customer-1" } : null) },
    $queryRaw: vi.fn(async (query: { strings: string[] }) => query.strings.join("").includes('"commerce"."Shop"')
      ? [{ id: "shop-1", status: "ACTIVE" }] : [context]),
    shop: { findUnique: vi.fn(async () => ({ status: "ACTIVE" })) },
    subscription: { findUnique: vi.fn(async () => ({ status: "ACTIVE", plan: { active: true, features: [{ featureId: "checkout_recovery" }] } })) },
    shopHumanMessagingRestriction: { findUnique: vi.fn(async () => options.suspended ? { status: "SUSPENDED" } : null) },
    conversation: { updateMany: vi.fn(async () => ({ count: 1 })) },
    conversationControlEvent: { create: vi.fn(async () => ({ id: "event-1" })) },
    merchantConversationSendCommand: {
      findUnique: vi.fn(async () => options.existing ? {
        id: "command-1", conversationId: "conversation-1", state: "ACCEPTED", kind: "HUMAN_TEXT",
        payloadSha256: humanSendPayloadHash("conversation-1", { kind: "HUMAN_TEXT", idempotencyKey: "send-12345678",
          expectedControlRevision: 1, textBody: "Hello" }),
      } : null),
      create: vi.fn<(args: Prisma.MerchantConversationSendCommandCreateArgs) => Promise<{
        id: string; state: string; kind: string;
      }>>(async () => ({ id: "command-1", state: "ACCEPTED", kind: "HUMAN_TEXT" })),
    },
    recoveryOutreachAttempt: { findUnique: vi.fn(async (query: { where: { checkoutRecoveryId_sequence?: { sequence: number } } }) =>
      query.where.checkoutRecoveryId_sequence?.sequence === 2
        ? { id: "attempt-2", status: "PENDING", initiationKey: options.secondClaimed ? "prior-claim" : null, outboundMessageId: null }
        : { id: "attempt-1", recipient: "+447700900001", sentAt: new Date("2026-10-17"),
          configuredOfferMode: "NONE", fixedShopifyDiscountId: null, offerSnapshot: null }),
      create: vi.fn(async () => ({ id: "attempt-2" })), updateMany: vi.fn(async () => ({ count: 1 })) },
    whatsAppTemplateVariant: { findFirst: vi.fn(async () => options.templateApproved
      ? { providerTemplateName: "recovery_reminder", providerLanguageCode: "en" } : null) },
    whatsAppRecipientReachability: { findUnique: vi.fn(async () => null) },
    conversationMessage: { findFirst: vi.fn(async () => options.inbound ? { createdAt: new Date(Date.now() - 60_000) } : null) },
  };
  const db = { $transaction: vi.fn(async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx)) } as unknown as PrismaClient;
  return { tx, db };
}
const sendInput = { kind: "HUMAN_TEXT" as const, expectedControlRevision: 1,
  idempotencyKey: "send-12345678", textBody: "Hello" };
const error = (code: string) => expect.objectContaining({ code });

describe("ARCH-040 Shopify human commands", () => {
  it("uses recovery ownership even if a conversation is known", async () => {
    const { db, tx } = fixture({ owned: false });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db)).rejects.toMatchObject({ code: "not_found" });
    expect(tx.merchantConversationSendCommand.create).not.toHaveBeenCalled();
  });
  it("requires a HUMAN CAS revision and does not switch mode as part of send", async () => {
    const { db, tx } = fixture({ mode: "AI" });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db)).rejects.toMatchObject({ code: "not_human_controlled" });
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
  });
  it("denies human sends under platform suspension but permits Resume AI", async () => {
    const { db, tx } = fixture({ suspended: true });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db)).rejects.toMatchObject({ code: "human_messaging_suspended" });
    expect(await changeRecoveryControl("shop-1", "recovery-1", { targetMode: "AI", expectedControlRevision: 1 }, db)).toEqual({ controlMode: "AI", controlRevision: 2 });
    expect(tx.conversationControlEvent.create).toHaveBeenCalledTimes(1);
  });
  it("rejects free text when no recorded verified customer inbound exists", async () => {
    const { db, tx } = fixture({ inbound: false });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db)).rejects.toMatchObject({ code: "service_window_closed" });
    expect(tx.merchantConversationSendCommand.create).not.toHaveBeenCalled();
  });
  it("rejects disallowed C0 controls before writing a command", async () => {
    const { db, tx } = fixture();
    for (const character of ["\u0000", "\u0008", "\u000b", "\u000c", "\u001f"]) {
      await expect(admitRecoveryHumanSend("shop-1", "recovery-1", {
        ...sendInput, textBody: `Before${character}after`,
      }, db)).rejects.toMatchObject(error("invalid_request"));
    }
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.merchantConversationSendCommand.create).not.toHaveBeenCalled();
  });
  it("continues to allow TAB, LF and CR inside a human reply", async () => {
    const { db } = fixture();
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", {
      ...sendInput, textBody: "Hello\tthere\nnext\rline",
    }, db)).resolves.toMatchObject({ state: "ACCEPTED" });
  });
  it("accepts only one durable command and labels it ACCEPTED, not SENT", async () => {
    const { db, tx } = fixture();
    expect(await admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db)).toMatchObject({
      commandId: "command-1", state: "ACCEPTED", replay: false,
    });
    expect(tx.merchantConversationSendCommand.create).toHaveBeenCalledTimes(1);
    expect(tx.merchantConversationSendCommand.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        kind: "HUMAN_TEXT", textBody: "Hello", templateParameters: Prisma.DbNull,
        templateName: null, templateLanguageCode: null, recoveryOutreachAttemptId: null,
      }),
    }));
    // Prisma null sentinels are structurally similar objects. Vitest deep matching
    // cannot distinguish them; compare their exact runtime identities instead.
    const submitted = tx.merchantConversationSendCommand.create.mock.calls[0]?.[0];
    expect(submitted?.data.templateParameters).toBe(Prisma.DbNull);
    expect(submitted?.data.templateParameters).not.toBe(Prisma.JsonNull);
  });
  it("replays an identical command by the same shop key without creating another row", async () => {
    const { db, tx } = fixture({ existing: true });
    expect(await admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db)).toMatchObject({ replay: true, commandId: "command-1" });
    expect(tx.merchantConversationSendCommand.create).not.toHaveBeenCalled();
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", { ...sendInput, textBody: "Changed" }, db))
      .rejects.toMatchObject(error("idempotency_conflict"));
  });
  it("refuses an old control revision, including during Take Over", async () => {
    const { db, tx } = fixture({ mode: "AI", revision: 2 });
    await expect(changeRecoveryControl("shop-1", "recovery-1", { targetMode: "HUMAN", expectedControlRevision: 1 }, db))
      .rejects.toMatchObject({ code: "stale_control_revision" });
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
  });
  it("returns the current trusted control state for a stale revision", async () => {
    const { db } = fixture({ mode: "AI", revision: 3 });
    await expect(changeRecoveryControl("shop-1", "recovery-1", { targetMode: "HUMAN", expectedControlRevision: 1 }, db))
      .rejects.toMatchObject({ code: "stale_control_revision", currentControl: { controlMode: "AI", controlRevision: 3 } });
  });
  it("claims the existing shared sequence-two follow-up in the same command transaction", async () => {
    const { db, tx } = fixture({ inbound: false });
    await admitRecoveryHumanSend("shop-1", "recovery-1", {
      kind: "RECOVERY_FOLLOW_UP_TEMPLATE", templateVariantId: "variant-1", idempotencyKey: "template-send-01",
      expectedControlRevision: 1,
    }, db);
    expect(tx.recoveryOutreachAttempt.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ initiatedBy: "HUMAN", initiationKey: "template-send-01" }),
    }));
    expect(tx.merchantConversationSendCommand.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ recoveryOutreachAttemptId: "attempt-2", templateName: "recovery_reminder",
        templateParameters: {} }),
    }));
  });
  it("rejects a prior sequence-two claim or an unapproved template without creating a command", async () => {
    const prior = fixture({ inbound: false, secondClaimed: true });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", {
      kind: "RECOVERY_FOLLOW_UP_TEMPLATE", templateVariantId: "variant-1", idempotencyKey: "template-send-02",
      expectedControlRevision: 1,
    }, prior.db)).rejects.toMatchObject({ code: "follow_up_unavailable" });
    expect(prior.tx.merchantConversationSendCommand.create).not.toHaveBeenCalled();
    const denied = fixture({ inbound: false, templateApproved: false });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", {
      kind: "RECOVERY_FOLLOW_UP_TEMPLATE", templateVariantId: "variant-1", idempotencyKey: "template-send-03",
      expectedControlRevision: 1,
    }, denied.db)).rejects.toMatchObject({ code: "template_not_allowed" });
    expect(denied.tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
  });
});
