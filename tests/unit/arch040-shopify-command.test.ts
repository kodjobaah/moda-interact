import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma, type PrismaClient } from "@prisma/client";
vi.mock("../../app/db.server", () => ({ default: {} }));
vi.mock("../../app/services/recoveries/recovery-follow-up-sender.server", () => ({
  trustedRecoverySenderWaba: async () => "1234567890",
}));
import { validFollowUpVariant } from "../fixtures/arch047-shopify-follow-up";
const { changeRecoveryControl, admitRecoveryHumanSend, humanSendPayloadHash } =
  await import("../../app/services/recoveries/recovery-human-commands.server");

function fixture(input?: { owned?: boolean; mode?: "AI" | "HUMAN"; revision?: number; suspended?: boolean;
  inbound?: boolean; inboundAt?: Date | null; sentAt?: Date | null; followUpDueAt?: Date | null;
  existing?: boolean; secondClaimed?: boolean; secondClaimedAt?: Date | null; templateApproved?: boolean }) {
  const options = { owned: true, mode: "HUMAN", revision: 1, suspended: false, inbound: true,
    existing: false, secondClaimed: false, templateApproved: true, ...input };
  const context = { id: "conversation-1", controlMode: options.mode, controlRevision: options.revision,
    inboundVersion: 7, languageTag: "en" };
  const tx = {
    checkoutRecovery: { findFirst: vi.fn(async () => options.owned ? { id: "recovery-1", shopId: "shop-1", status: "ENGAGED", customerId: "customer-1" } : null) },
    $queryRaw: vi.fn(async (query: { strings: string[] }) => query.strings.join("").includes('"commerce"."Shop"')
      ? [{ id: "shop-1", status: "ACTIVE" }] : [context]),
    shop: { findUnique: vi.fn(async () => ({ status: "ACTIVE", platform: "SHOPIFY", defaultLanguageTag: "en" })) },
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
        ? { id: "attempt-2", status: "PENDING", initiationKey: options.secondClaimed ? "prior-claim" : null,
          claimedAt: options.secondClaimedAt ?? null, outboundMessageId: null }
        : { id: "attempt-1", recipient: "+447700900001",
          sentAt: options.sentAt === undefined ? new Date("2026-10-17T00:00:00.000Z") : options.sentAt,
          followUpDueAt: options.followUpDueAt === undefined ? new Date("2026-10-17T01:00:00.000Z") : options.followUpDueAt,
          configuredOfferMode: "NONE", fixedShopifyDiscountId: null, offerSnapshot: null }),
      create: vi.fn(async () => ({ id: "attempt-2" })), updateMany: vi.fn(async () => ({ count: 1 })) },
    whatsAppTemplateVariant: { findMany: vi.fn(async () => options.templateApproved
      ? [validFollowUpVariant] : []) },
    whatsAppTemplatePublicationTarget: { findMany: vi.fn(async () => [{
      newVariantId: "variant-1", metaRegistrationId: "registration-1", languageTag: "en",
    }]) },
    whatsAppRecipientReachability: { findUnique: vi.fn(async () => null) },
    conversationMessage: { findFirst: vi.fn(async () => options.inbound
      ? { createdAt: options.inboundAt ?? new Date(Date.now() - 60_000) } : null) },
  };
  const db = { $transaction: vi.fn(async (fn: (arg: typeof tx) => Promise<unknown>) => fn(tx)) } as unknown as PrismaClient;
  return { tx, db };
}
const sendInput = { kind: "HUMAN_TEXT" as const, expectedControlRevision: 1,
  idempotencyKey: "send-12345678", textBody: "Hello" };
const error = (code: string) => expect.objectContaining({ code });
const templateInput = { kind: "RECOVERY_FOLLOW_UP_TEMPLATE" as const, templateVariantId: "variant-1",
  expectedControlRevision: 1, idempotencyKey: "template-send-01" };
afterEach(() => vi.useRealTimers());

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
  it.each([
    ["AI", "HUMAN"],
    ["HUMAN", "AI"],
  ] as const)("atomically invalidates pending AI and processing state for %s -> %s", async (mode, targetMode) => {
    const { db, tx } = fixture({ mode, revision: 4 });
    await expect(changeRecoveryControl("shop-1", "recovery-1", {
      targetMode, expectedControlRevision: 4,
    }, db)).resolves.toEqual({ controlMode: targetMode, controlRevision: 5 });

    expect(tx.conversation.updateMany).toHaveBeenCalledWith({
      where: { id: "conversation-1", controlRevision: 4, controlMode: mode, inboundVersion: 7 },
      data: expect.objectContaining({
        controlMode: targetMode,
        controlRevision: { increment: 1 },
        pendingTurnStartedAt: null,
        pendingAiNotBeforeAt: null,
        pendingAiControlRevision: null,
        pendingAiDelayMinutes: null,
        processingInboundVersion: null,
        processingStartedAt: null,
        lastProcessedVersion: 7,
      }),
    });
    expect(tx.conversationControlEvent.create).toHaveBeenCalledWith({
      data: { conversationId: "conversation-1", fromMode: mode, toMode: targetMode,
        fromRevision: 4, toRevision: 5 },
    });
  });

  it("does not clear a new turn when a concurrent control compare-and-set loses", async () => {
    const { db, tx } = fixture({ mode: "AI", revision: 4 });
    tx.conversation.updateMany.mockResolvedValue({ count: 0 });

    await expect(changeRecoveryControl("shop-1", "recovery-1", {
      targetMode: "HUMAN", expectedControlRevision: 4,
    }, db)).rejects.toMatchObject({ code: "stale_control_revision" });
    expect(tx.conversationControlEvent.create).not.toHaveBeenCalled();
  });

  it("does not alter pending state or revision for an idempotent control request", async () => {
    const { db, tx } = fixture({ mode: "AI", revision: 4 });
    await expect(changeRecoveryControl("shop-1", "recovery-1", {
      targetMode: "AI", expectedControlRevision: 4,
    }, db)).rejects.toMatchObject({ code: "control_already_selected" });
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
    expect(tx.conversationControlEvent.create).not.toHaveBeenCalled();
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

  it("rejects stale, forged, retired and unlinked Moda follow-up variants before sequence-two claim", async () => {
    const invalid = [
      { metaRegistrationId: null },
      { providerAccountId: "9999999999" },
      { purpose: "checkout-recovery" },
      { metaRegistration: { ...validFollowUpVariant.metaRegistration, providerStatus: "PAUSED" } },
      { metaRegistration: { ...validFollowUpVariant.metaRegistration, locale: {
        ...validFollowUpVariant.metaRegistration.locale, definition: {
          ...validFollowUpVariant.metaRegistration.locale.definition, retiredAt: new Date(),
        },
      } } },
    ];
    for (const bad of invalid) {
      const { tx, db } = fixture({ inbound: false });
      tx.whatsAppTemplateVariant.findMany.mockResolvedValue([{ ...validFollowUpVariant, ...bad }] as never);
      await expect(admitRecoveryHumanSend("shop-1", "recovery-1", templateInput, db))
        .rejects.toMatchObject({ code: "template_not_allowed" });
      expect(tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
      expect(tx.merchantConversationSendCommand.create).not.toHaveBeenCalled();
    }
  });

  it("never accepts a positive-offer template using only a saved configured discount", async () => {
    const { tx, db } = fixture({ inbound: false });
    tx.whatsAppTemplateVariant.findMany.mockResolvedValue([{
      ...validFollowUpVariant, purpose: "FOLLOW_UP_CODE_OFFER",
      metaRegistration: { ...validFollowUpVariant.metaRegistration, locale: {
        ...validFollowUpVariant.metaRegistration.locale,
        definition: { ...validFollowUpVariant.metaRegistration.locale.definition, offerType: "CODE_OFFER" },
      } },
    }] as never);
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", templateInput, db))
      .rejects.toMatchObject({ code: "template_not_allowed" });
    expect(tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
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


describe("ARCH-040-SHOPIFY-005 verified service-window admission", () => {
  const initialSent = new Date("2026-10-20T10:00:00.000Z");
  const clock = new Date("2026-10-20T12:00:00.000Z");
  function at(time: Date) { vi.useFakeTimers(); vi.setSystemTime(time); }

  it("selects only provider-verified CUSTOMER inbound since initial send, bounded by the transaction clock", async () => {
    at(clock);
    const inboundAt = new Date(clock.getTime() - 60_000);
    const { db, tx } = fixture({ sentAt: initialSent, inboundAt });
    await admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db);
    expect(tx.conversationMessage.findFirst).toHaveBeenCalledWith({
      where: { conversationId: "conversation-1", direction: "INBOUND", senderType: "CUSTOMER",
        providerMessageId: { not: null }, createdAt: { gte: initialSent, lte: clock } },
      select: { createdAt: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    expect(tx.whatsAppRecipientReachability.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.merchantConversationSendCommand.create).toHaveBeenCalledTimes(1);
  });

  it("denies free text without a sent initial outreach even when an inbound mock exists", async () => {
    at(clock);
    const { db, tx } = fixture({ sentAt: null, inboundAt: clock });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db))
      .rejects.toMatchObject(error("service_window_closed"));
    expect(tx.conversationMessage.findFirst).not.toHaveBeenCalled();
    expect(tx.merchantConversationSendCommand.create).not.toHaveBeenCalled();
  });

  it.each([
    ["just before expiry", 86_400_000 - 1, true],
    ["at expiry", 86_400_000, false],
    ["after expiry", 86_400_000 + 1, false],
  ])("%s uses the exact rolling 24h window", async (_, elapsed, allowed) => {
    const inboundAt = new Date(initialSent.getTime() + 60_000);
    at(new Date(inboundAt.getTime() + (elapsed as number)));
    const { db, tx } = fixture({ sentAt: initialSent, inboundAt });
    if (allowed) {
      await expect(admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db))
        .resolves.toMatchObject({ replay: false });
    } else {
      await expect(admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db))
        .rejects.toMatchObject(error("service_window_closed"));
      expect(tx.merchantConversationSendCommand.create).not.toHaveBeenCalled();
    }
  });

  it("a more recent verified inbound resets the window, not control mode or sequence 2", async () => {
    at(clock);
    const recent = new Date(clock.getTime() - 60_000);
    const { db, tx } = fixture({ sentAt: new Date(clock.getTime() - 4 * 86_400_000), inboundAt: recent });
    await admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db);
    expect(tx.conversation.updateMany).not.toHaveBeenCalled();
    expect(tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
    expect(tx.recoveryOutreachAttempt.create).not.toHaveBeenCalled();
    expect(tx.conversationMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }));
  });

  it.each([
    ["pre-initial", new Date(initialSent.getTime() - 1)],
    ["future", new Date(clock.getTime() + 1)],
  ])("%s inbound cannot authorize free text", async (_, inboundAt) => {
    at(clock);
    const { db, tx } = fixture({ sentAt: initialSent, inboundAt });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db))
      .rejects.toMatchObject(error("service_window_closed"));
    expect(tx.merchantConversationSendCommand.create).not.toHaveBeenCalled();
  });

  it.each([
    ["15 minutes already due", 15, 30, true],
    ["60 minutes not due", 60, 30, false],
    ["60 minutes exactly due", 60, 60, true],
    ["48 hours not due", 48 * 60, 30, false],
    ["48 hours due", 48 * 60, 48 * 60, true],
  ])("template follows persisted %s instead of an extra 24h delay", async (_, delayMinutes, elapsedMinutes, allow) => {
    const sentAt = new Date("2026-10-15T10:00:00.000Z");
    const due = new Date(sentAt.getTime() + (delayMinutes as number) * 60_000);
    at(new Date(sentAt.getTime() + (elapsedMinutes as number) * 60_000));
    const { db, tx } = fixture({ inbound: false, sentAt, followUpDueAt: due });
    if (allow) {
      await expect(admitRecoveryHumanSend("shop-1", "recovery-1", templateInput, db))
        .resolves.toMatchObject({ replay: false });
      expect(tx.recoveryOutreachAttempt.updateMany).toHaveBeenCalledTimes(1);
    } else {
      await expect(admitRecoveryHumanSend("shop-1", "recovery-1", templateInput, db))
        .rejects.toMatchObject(error("follow_up_unavailable"));
      expect(tx.recoveryOutreachAttempt.create).not.toHaveBeenCalled();
      expect(tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["disabled or unscheduled", null, initialSent],
    ["initial not sent", new Date(initialSent.getTime() + 60_000), null],
  ])("rejects %s follow-up even if there was no customer reply", async (_, due, sentAt) => {
    at(clock);
    const { db, tx } = fixture({ inbound: false, sentAt, followUpDueAt: due });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", templateInput, db))
      .rejects.toMatchObject(error("follow_up_unavailable"));
    expect(tx.whatsAppTemplateVariant.findMany).not.toHaveBeenCalled();
    expect(tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("the verified window blocks the template even after the configured due time", async () => {
    at(clock);
    const { db, tx } = fixture({ sentAt: initialSent, followUpDueAt: new Date(initialSent.getTime() + 15 * 60_000),
      inboundAt: new Date(clock.getTime() - 60_000) });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", templateInput, db))
      .rejects.toMatchObject(error("follow_up_unavailable"));
    expect(tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("already claimed sequence 2 is unavailable even when the configured deadline has passed", async () => {
    at(clock);
    const { db, tx } = fixture({ inbound: false, sentAt: initialSent,
      followUpDueAt: new Date(initialSent.getTime() + 15 * 60_000), secondClaimedAt: initialSent });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", templateInput, db))
      .rejects.toMatchObject(error("follow_up_unavailable"));
    expect(tx.recoveryOutreachAttempt.updateMany).not.toHaveBeenCalled();
  });

  it("replay is returned before new eligibility checks, even after the service window closes", async () => {
    at(clock);
    const { db, tx } = fixture({ existing: true, inbound: false, sentAt: null, followUpDueAt: null });
    await expect(admitRecoveryHumanSend("shop-1", "recovery-1", sendInput, db))
      .resolves.toMatchObject({ replay: true, commandId: "command-1" });
    expect(tx.recoveryOutreachAttempt.findUnique).not.toHaveBeenCalled();
    expect(tx.conversationMessage.findFirst).not.toHaveBeenCalled();
  });
});
