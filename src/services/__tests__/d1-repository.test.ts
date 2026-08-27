import { describe, expect, test } from "bun:test";

import { Effect, Layer } from "effect";

import type { Message } from "../../domain/message";
import { messageRepositoryD1 } from "../d1-repository";
import { D1 } from "../d1-service";
import type { D1Service, D1Statement } from "../d1-service";
import type { GoogleMessageEvent } from "../google-messages";
import { MessageRepository } from "../repositories";
import { StorageError } from "../storage-error";

const makeEvent = (): GoogleMessageEvent => ({
  id: "event-1",
  message: {
    // SAFETY: test identifiers satisfy the branded domain identifier contract.
    conversationId: "conversation-1" as Message["conversationId"],
    externalId: "message-1",
    // SAFETY: test identifiers satisfy the branded domain identifier contract.
    id: "message-1" as Message["id"],
    outgoing: false,
    // SAFETY: test identifiers satisfy the branded domain identifier contract.
    senderId: "sender-1" as Message["senderId"],
    sentAt: new Date("2026-01-01T00:00:00.000Z"),
    text: "inbound",
    transport: "rcs",
  },
});

const makeDatabase = (
  runs: number[],
  batches: D1Statement[][],
  failFirstBatch = false,
  firstBatchChanges = 1,
  batchChanges: number[][] = []
): D1Service => {
  // Model the marker visibility between batches and the statement ordering within one.
  // A failed batch does not commit its staged marker, matching D1 transaction behavior.
  const protocolEventIds = new Set<string>();
  return {
    all: () => Effect.succeed([]),
    batch: (statements) => {
      batches.push([...statements]);
      if (failFirstBatch && batches.length === 1) {
        return Effect.fail(
          new StorageError({ cause: "batch failed", operation: "test.batch" })
        );
      }
      const stagedEventIds = new Set(protocolEventIds);
      const changes = statements.map((statement, index) => {
        if (statement.query.includes("INSERT OR IGNORE INTO protocol_events")) {
          const eventId = String(statement.parameters[0]);
          if (stagedEventIds.has(eventId)) {
            return 0;
          }
          stagedEventIds.add(eventId);
          return 1;
        }
        if (statement.query.includes("NOT EXISTS")) {
          const eventId = String(statement.parameters.at(-1));
          if (stagedEventIds.has(eventId)) {
            return 0;
          }
          return index === 0 ? firstBatchChanges : 1;
        }
        return index === 0 ? firstBatchChanges : 1;
      });
      protocolEventIds.clear();
      for (const eventId of stagedEventIds) {
        protocolEventIds.add(eventId);
      }
      batchChanges.push(changes);
      return Effect.succeed(changes);
    },
    first: () => Effect.succeed(null),
    run: () => {
      runs.push(1);
      return Effect.succeed(runs.length === 1 ? 1 : 0);
    },
  };
};

const repositoryServices = (database: D1Service) =>
  messageRepositoryD1().pipe(Layer.provide(Layer.succeed(D1, database)));

test("does not persist a delivery after the owner loses the reservation", async () => {
  const runs: number[] = [];
  const batches: D1Statement[][] = [];
  const repository = await Effect.runPromise(
    Effect.provide(
      Effect.service(MessageRepository),
      repositoryServices(makeDatabase(runs, batches, false, 0))
    )
  );

  const result = await Effect.runPromiseExit(
    repository.commitDelivery(
      "delivery-key",
      "stale-owner",
      makeEvent().message
    )
  );

  expect(result._tag).toBe("Failure");
  expect(batches).toHaveLength(1);
  expect(batches[0]?.[0]?.query).toContain("owner = ?");
  expect(batches[0]?.at(-1)?.query).toContain("status = 'completed'");
});

describe("D1 event ingestion", () => {
  test("persists the message and cursor after first-seen event", async () => {
    const runs: number[] = [];
    const batches: D1Statement[][] = [];
    const repository = await Effect.runPromise(
      Effect.provide(
        Effect.service(MessageRepository),
        repositoryServices(makeDatabase(runs, batches))
      )
    );

    await Effect.runPromise(repository.ingestEvent(makeEvent()));

    expect(runs).toHaveLength(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(7);
    expect(batches[0]?.at(-1)?.query).toContain("protocol_events");
    expect(batches[0]?.at(-2)?.query).toContain("sync_state");
  });

  test("does not write duplicate events or advance the cursor", async () => {
    const runs: number[] = [];
    const batches: D1Statement[][] = [];
    const batchChanges: number[][] = [];
    const repository = await Effect.runPromise(
      Effect.provide(
        Effect.service(MessageRepository),
        repositoryServices(makeDatabase(runs, batches, false, 1, batchChanges))
      )
    );

    await Effect.runPromise(repository.ingestEvent(makeEvent()));
    await Effect.runPromise(repository.ingestEvent(makeEvent()));

    expect(batches).toHaveLength(2);
    expect(batchChanges[0]).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(batchChanges[1]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("retries the entire ingest batch after a failure", async () => {
    const runs: number[] = [];
    const batches: D1Statement[][] = [];
    const batchChanges: number[][] = [];
    const repository = await Effect.runPromise(
      Effect.provide(
        Effect.service(MessageRepository),
        repositoryServices(makeDatabase(runs, batches, true, 1, batchChanges))
      )
    );

    const first = await Effect.runPromiseExit(
      repository.ingestEvent(makeEvent())
    );
    await Effect.runPromise(repository.ingestEvent(makeEvent()));

    expect(first._tag).toBe("Failure");
    expect(batches).toHaveLength(2);
    expect(batchChanges).toEqual([[1, 1, 1, 1, 1, 1, 1]]);
  });
});
