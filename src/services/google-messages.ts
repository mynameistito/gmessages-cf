import { Context, Effect, Layer, Stream } from "effect";

import type { Conversation, Message } from "../domain/message";
import { GoogleMessagesError } from "./google-messages-error";

export { GoogleMessagesError } from "./google-messages-error";

/** Typed failure from the protocol adapter. */
/** Application-owned Google Messages port. libgm is deliberately hidden behind it. */
export interface GoogleMessagesService {
  readonly connect: Effect.Effect<void, GoogleMessagesError>;
  readonly conversations: Effect.Effect<
    readonly Conversation[],
    GoogleMessagesError
  >;
  readonly messages: (
    conversationId: string
  ) => Effect.Effect<readonly Message[], GoogleMessagesError>;
  readonly send: (
    conversationId: string,
    text: string,
    idempotencyKey: string
  ) => Effect.Effect<Message, GoogleMessagesError>;
  readonly events: Stream.Stream<GoogleMessageEvent, GoogleMessagesError>;
}

export interface GoogleMessageEvent {
  readonly id: string;
  readonly message: Message;
}

/** Google Messages protocol capability. */
export class GoogleMessages extends Context.Service<
  GoogleMessages,
  GoogleMessagesService
>()("gmessages/GoogleMessages") {}

/** Deterministic fake provider for local development and CI. */
export const GoogleMessagesTest = Layer.effect(
  GoogleMessages,
  Effect.gen(function* GoogleMessagesTest() {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const conversation = {
      // SAFETY: fixture identifiers are constructed once and retained as branded domain values.
      id: "conversation-demo" as Conversation["id"],
      lastMessageAt: now,
      participantIds: [
        // SAFETY: this fixture is the only construction site for the branded participant identifier.
        "participant-demo" as Conversation["participantIds"][number],
      ],
      title: "Demo contact",
      unreadCount: 0,
    } satisfies Conversation;
    const [senderId] = conversation.participantIds;
    if (senderId === undefined) {
      return yield* Effect.fail(
        new GoogleMessagesError({
          reason: "fixture has no sender",
          retryable: false,
        })
      );
    }
    const initial = {
      conversationId: conversation.id,
      externalId: "fake-external-demo",
      // SAFETY: this fixture is the only construction site for the branded message identifier.
      id: "message-demo" as Message["id"],
      outgoing: false,
      senderId,
      sentAt: now,
      text: "Fake Google Messages is ready.",
      transport: "rcs" as const,
    } satisfies Message;
    const state = { sendCount: 0 };
    const events = Stream.empty;
    return {
      connect: Effect.logDebug("fake Google Messages connected"),
      conversations: Effect.succeed([conversation]),
      events,
      messages: (_conversationId) => Effect.succeed([initial]),
      send: (conversationId, text, _idempotencyKey) =>
        Effect.sync(() => {
          state.sendCount += 1;
          return {
            ...initial,
            // SAFETY: the provider receives a conversation identifier from the typed application port.
            conversationId: conversationId as Message["conversationId"],
            externalId: `fake-external-${state.sendCount}`,
            // SAFETY: this generated identifier is unique within the fake provider instance.
            id: `message-${state.sendCount}-${conversationId}` as Message["id"],
            outgoing: true,
            sentAt: new Date("2026-01-01T00:00:01.000Z"),
            text,
          };
        }),
    } satisfies GoogleMessagesService;
  })
);
