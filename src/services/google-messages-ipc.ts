import { Effect, Layer, Redacted, Schema, Stream } from "effect";

import type { Conversation, Message } from "../domain/message";
import { GoogleMessages, GoogleMessagesError } from "./google-messages";
import type {
  GoogleMessageEvent,
  GoogleMessagesService,
} from "./google-messages";

const ConversationWire = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  unread: Schema.Boolean,
  updatedAtMs: Schema.Number,
});

const ConversationsWire = Schema.Struct({
  conversations: Schema.Array(ConversationWire),
});

const MessageWire = Schema.Struct({
  conversationId: Schema.String,
  externalId: Schema.String,
  id: Schema.String,
  outgoing: Schema.Boolean,
  senderId: Schema.String,
  sentAt: Schema.String,
  text: Schema.String,
  transport: Schema.Union([
    Schema.Literal("mms"),
    Schema.Literal("rcs"),
    Schema.Literal("sms"),
  ]),
});

const MessagesWire = Schema.Struct({ messages: Schema.Array(MessageWire) });

const decodeMessage = (
  message: Schema.Schema.Type<typeof MessageWire>
): Message => ({
  // SAFETY: MessageWire parsed this provider identifier before projection.
  conversationId: message.conversationId as Message["conversationId"],
  externalId: message.externalId,
  // SAFETY: MessageWire parsed this message identifier before projection.
  id: message.id as Message["id"],
  outgoing: message.outgoing,
  // SAFETY: MessageWire parsed this participant identifier before projection.
  senderId: message.senderId as Message["senderId"],
  sentAt: new Date(message.sentAt),
  text: message.text,
  transport: message.transport,
});

const reconnectDelay = () =>
  // eslint-disable-next-line promise/avoid-new -- setTimeout has no promise API.
  new Promise<void>((resolve) => {
    setTimeout(resolve, 1000);
  });

// SAFETY: SSE transport reads and reconnects must remain sequential.
// eslint-disable-next-line sonarjs/cognitive-complexity -- parsing a small SSE state machine is clearer inline.
const readEvents = async function* readEvents(
  options: GoogleMessagesIpcOptions
): AsyncGenerator<GoogleMessageEvent> {
  let lastEventId: string | undefined;
  while (true) {
    const headers = new Headers({ accept: "text/event-stream" });
    headers.set("authorization", `Bearer ${Redacted.value(options.token)}`);
    if (lastEventId !== undefined) {
      headers.set("last-event-id", lastEventId);
    }
    const request = new globalThis.Request(
      new URL("v1/events", options.baseUrl).toString(),
      { headers }
    );
    // eslint-disable-next-line no-await-in-loop -- each reconnect depends on the previous stream ending.
    const response = await (options.fetcher?.(request) ?? fetch(request));
    if (!response.ok || response.body === null) {
      // A failed connection is recoverable; retain the cursor and retry.
      // eslint-disable-next-line no-await-in-loop -- reconnect waits are sequential.
      await reconnectDelay();
      continue;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventId = "";
    let data = "";
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- chunks must be decoded in arrival order.
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          if (data !== "") {
            try {
              const payload = Schema.decodeUnknownSync(MessageWire)(
                JSON.parse(data)
              );
              const message = decodeMessage(payload);
              const id = eventId || message.externalId;
              yield { id, message };
              lastEventId = id;
            } catch {
              // Malformed and unknown events are ignored without advancing the cursor.
            }
          }
          eventId = "";
          data = "";
        } else if (line.startsWith("id:")) {
          eventId = line.slice(3).trim();
        } else if (line.startsWith("data:")) {
          data += line.slice(5).trim();
        }
      }
    }
    // eslint-disable-next-line no-await-in-loop -- reconnect waits are sequential.
    await reconnectDelay();
  }
};

/** Configuration for the isolated libgm IPC service. */
export interface GoogleMessagesIpcOptions {
  readonly baseUrl: URL;
  readonly fetcher?: (request: Request) => Promise<Response>;
  readonly token: Redacted.Redacted<string>;
}

const makeGoogleMessagesIpc = (
  options: GoogleMessagesIpcOptions
): GoogleMessagesService => {
  const request = (
    path: string,
    init?: RequestInit
  ): Effect.Effect<unknown, GoogleMessagesError, never> =>
    Effect.tryPromise({
      catch: () =>
        new GoogleMessagesError({
          reason: "ipc request failed",
          retryable: true,
        }),
      try: async () => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${Redacted.value(options.token)}`);
        const outgoing = new globalThis.Request(
          new URL(path, options.baseUrl).toString(),
          {
            ...init,
            headers,
          }
        );
        const response = await (options.fetcher?.(outgoing) ?? fetch(outgoing));
        if (!response.ok) {
          throw new Error(`IPC returned ${response.status}`);
        }
        return response.json();
      },
    }).pipe(
      Effect.mapError(
        () =>
          new GoogleMessagesError({
            reason: "ipc request failed",
            retryable: true,
          })
      )
    );

  const connect = request("v1/connect", { method: "POST" }).pipe(
    Effect.asVoid,
    Effect.mapError(
      () =>
        new GoogleMessagesError({ reason: "connect failed", retryable: true })
    )
  );

  return {
    connect,
    conversations: Effect.gen(function* conversations() {
      const payload = yield* request("v1/conversations");
      const decoded =
        yield* Schema.decodeUnknownEffect(ConversationsWire)(payload);
      return decoded.conversations.map((conversation) => {
        // SAFETY: the wire schema guarantees a non-empty provider identifier is not required by this projection.
        const id = conversation.id as Conversation["id"];
        return {
          id,
          lastMessageAt: new Date(conversation.updatedAtMs),
          participantIds: [],
          title: conversation.title,
          unreadCount: conversation.unread ? 1 : 0,
        } satisfies Conversation;
      });
    }).pipe(
      Effect.mapError(
        () =>
          new GoogleMessagesError({
            reason: "conversation request failed",
            retryable: true,
          })
      )
    ),
    events: Stream.fromAsyncIterable(
      readEvents(options),
      () =>
        new GoogleMessagesError({
          reason: "event stream failed",
          retryable: true,
        })
    ),
    messages: (conversationId) =>
      Effect.gen(function* messages() {
        const payload = yield* request(
          `v1/conversations/${encodeURIComponent(conversationId)}/messages`
        );
        const decoded =
          yield* Schema.decodeUnknownEffect(MessagesWire)(payload);
        return decoded.messages.map(decodeMessage);
      }).pipe(
        Effect.mapError(
          () =>
            new GoogleMessagesError({
              reason: "message request failed",
              retryable: true,
            })
        )
      ),
    send: (conversationId, text, idempotencyKey) =>
      Effect.gen(function* send() {
        const payload = yield* request(
          `v1/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            body: JSON.stringify({ idempotencyKey, text }),
            headers: { "content-type": "application/json" },
            method: "POST",
          }
        );
        const decoded = yield* Schema.decodeUnknownEffect(MessageWire)(payload);
        return decodeMessage(decoded);
      }).pipe(
        Effect.mapError(
          () =>
            new GoogleMessagesError({
              reason: "send request failed",
              retryable: true,
            })
        )
      ),
  };
};

/** Creates the real provider boundary without enabling it by default. */
export const googleMessagesIpc = (options: GoogleMessagesIpcOptions) =>
  Layer.succeed(GoogleMessages, makeGoogleMessagesIpc(options));
