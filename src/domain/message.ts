import { Schema } from "effect";

/** Stable identifier for an application message. */
export const MessageId = Schema.String.pipe(Schema.brand("MessageId"));
/** Stable identifier for a conversation. */
export const ConversationId = Schema.String.pipe(
  Schema.brand("ConversationId")
);
/** Stable identifier for a participant. */
export const ParticipantId = Schema.String.pipe(Schema.brand("ParticipantId"));

/** Supported message transports. */
export const MessageTransport = Schema.Union([
  Schema.Literal("mms"),
  Schema.Literal("rcs"),
  Schema.Literal("sms"),
]);
/** A persisted message. */
export const MessageSchema = Schema.Struct({
  conversationId: ConversationId,
  externalId: Schema.String,
  id: MessageId,
  outgoing: Schema.Boolean,
  senderId: ParticipantId,
  sentAt: Schema.Date,
  text: Schema.String,
  transport: MessageTransport,
});
/** A conversation summary. */
export const ConversationSchema = Schema.Struct({
  id: ConversationId,
  lastMessageAt: Schema.Date,
  participantIds: Schema.Array(ParticipantId),
  title: Schema.String,
  unreadCount: Schema.Number,
});

export type Message = Schema.Schema.Type<typeof MessageSchema>;
export type Conversation = Schema.Schema.Type<typeof ConversationSchema>;
