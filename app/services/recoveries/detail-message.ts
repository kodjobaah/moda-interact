import { MessageContentType, MessageDirection, MessageSenderType, MessageStatus, MessageTranscriptionStatus, MerchantConversationSendState } from "@prisma/client";

export type RecoveryMessageRow = {
  id: string; createdAt: Date; direction: string | null; senderType: string | null;
  status: string | null; contentType: string | null; content: string | null;
  transcriptionStatus: string | null; moderationDecision?: string | null; humanCommandState?: string | null;
  commandOnly?: boolean; commandKind?: string | null; templateName?: string | null;
  sentAt: Date | null; deliveredAt: Date | null; readAt: Date | null;
};

function known<T extends string>(values: Record<string, T>, value: string | null): T | null {
  return Object.values(values).includes(value as T) ? value as T : null;
}

// Plain text only. Render text with React text nodes, never innerHTML/Markdown.
// Labels/localized dates are the consuming UI's responsibility; codes are stable.
export function recoveryMessageDto(row: RecoveryMessageRow) {
  const direction = known(MessageDirection, row.direction);
  const sender = known(MessageSenderType, row.senderType);
  const type = known(MessageContentType, row.contentType) ?? MessageContentType.UNSUPPORTED;
  const transcription = type === MessageContentType.AUDIO ? known(MessageTranscriptionStatus, row.transcriptionStatus) : null;
  return {
    id: row.id, moderation: sender === "CUSTOMER" && ["BLOCK", "REVIEW_REQUIRED"].includes(row.moderationDecision ?? "") ? "FLAGGED" as const : null, createdAt: row.createdAt.toISOString(), direction, sender,
    content: {
      type,
      text: type === MessageContentType.TEXT || (type === MessageContentType.AUDIO && transcription === MessageTranscriptionStatus.COMPLETED) ? row.content : null,
      transcriptionStatus: transcription,
      ...(row.commandOnly && row.commandKind === "RECOVERY_FOLLOW_UP_TEMPLATE" ?
        { templateName: row.templateName } : {}),
    },
    delivery: direction === MessageDirection.OUTBOUND ? {
      status: known(MessageStatus, row.status),
      // A no-provider-message command is a visible merchant attempt, never a fabricated receipt.
      ...(row.commandOnly ? { commandState: known(MerchantConversationSendState, row.humanCommandState ?? null) } : {}),
      // A terminal UNKNOWN send command can leave the historical provider row PENDING.
      // This is a display hint only: never mutate provider evidence or assert failure.
      ...(sender === MessageSenderType.HUMAN && row.status === MessageStatus.PENDING &&
        row.humanCommandState === "UNKNOWN" ? { unconfirmed: true as const } : {}),
      sentAt: row.sentAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      readAt: row.readAt?.toISOString() ?? null,
    } : null,
  };
}

export type RecoveryMessageDto = ReturnType<typeof recoveryMessageDto>;
