import { Effect } from "effect";

import { GoogleMessages, GoogleMessagesError } from "./google-messages";
import { MessageRepository } from "./repositories";
import { SendInProgressError } from "./send-in-progress-error";

/** Indicates that another delivery currently owns the idempotency key. */
/** Application operations exposed by HTTP and MCP adapters. */
export const MessagingService = {
  getConversation: (conversationId: string) =>
    Effect.gen(function* getConversation() {
      const repository = yield* Effect.service(MessageRepository);
      return yield* repository.get(conversationId);
    }),
  listConversations: Effect.gen(function* listConversations() {
    const provider = yield* Effect.service(GoogleMessages);
    const repository = yield* Effect.service(MessageRepository);
    yield* provider.connect;
    yield* repository.syncConversations(yield* provider.conversations);
    return yield* repository.listConversations;
  }),
  search: (query: string) =>
    Effect.gen(function* search() {
      const repository = yield* Effect.service(MessageRepository);
      return yield* repository.search(query);
    }),
  send: (conversationId: string, text: string, idempotencyKey: string) =>
    Effect.gen(function* send() {
      const provider = yield* Effect.service(GoogleMessages);
      const repository = yield* Effect.service(MessageRepository);
      const existing = yield* repository.findByIdempotencyKey(idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
      const reserved = yield* repository.reserveIdempotencyKey(
        idempotencyKey,
        conversationId,
        text
      );
      if (!reserved) {
        return yield* Effect.fail(new SendInProgressError({ idempotencyKey }));
      }
      yield* provider.connect.pipe(
        Effect.tapError(() => repository.releaseIdempotencyKey(idempotencyKey))
      );
      const message = yield* provider
        .send(conversationId, text, idempotencyKey)
        .pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError((error) =>
            "retryable" in error
              ? error
              : new GoogleMessagesError({
                  reason: "provider timeout",
                  retryable: true,
                })
          ),
          Effect.tapError((error) =>
            repository.failDelivery(
              idempotencyKey,
              error.reason,
              error.retryable
            )
          )
        );
      yield* repository.commitDelivery(idempotencyKey, message);
      return message;
    }),
};
