// oxlint-disable unicorn/import-style
// oxlint-disable unicorn/no-await-expression-member
// oxlint-disable unicorn/text-encoding-identifier-case
// oxlint-disable eslint(sort-keys)
// oxlint-disable eslint(prefer-destructuring)
// oxlint-disable eslint(curly)
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { D1Database } from "@cloudflare/workers-types";
import { Effect, Layer } from "effect";
import { getPlatformProxy } from "wrangler";

import type { Message } from "../../domain/message";
import { messageRepositoryD1 } from "../d1-repository";
import { MessageRepository } from "../repositories";
import { d1Live } from "../storage";

const event = {
  id: "event-1",
  message: {
    conversationId: "conversation-1" as Message["conversationId"],
    externalId: "message-1",
    id: "message-1" as Message["id"],
    outgoing: false,
    senderId: "sender-1" as Message["senderId"],
    sentAt: new Date("2026-01-01T00:00:00.000Z"),
    text: "inbound",
    transport: "rcs" as const,
  },
};

const migrations = async (root: string): Promise<string> => {
  const paths = [
    "0001_initial.sql",
    "0002_outbox_timestamps.sql",
    "0003_outbox_failures.sql",
    "0004_delivery_ownership.sql",
  ];
  return (
    await Promise.all(
      paths.map((path) => readFile(join(root, "migrations", path), "utf-8"))
    )
  ).join("\n");
};

describe("D1 repository against local Worker SQLite", () => {
  let dispose: (() => Promise<void>) | undefined;
  let db: D1Database;
  let services: Layer.Layer<MessageRepository>;
  let configPath: string;

  beforeAll(async () => {
    const root = process.cwd();
    const directory = await mkdtemp(join(tmpdir(), "gmessages-d1-"));
    configPath = join(directory, "wrangler.jsonc");
    await writeFile(
      configPath,
      JSON.stringify({
        compatibility_date: "2026-01-01",
        d1_databases: [
          {
            binding: "DB",
            database_id: "gmessages-d1-test",
            database_name: "gmessages-d1-test",
          },
        ],
        name: "gmessages-d1-test",
      })
    );
    const platform = await getPlatformProxy<{ DB: D1Database }>({
      configPath,
      persist: false,
      remoteBindings: false,
    });
    ({ dispose } = platform);
    ({ DB: db } = platform.env);
    await db.exec(await migrations(root));
    services = messageRepositoryD1().pipe(Layer.provide(d1Live(db)));
  });

  beforeEach(async () => {
    await db.exec(
      "DELETE FROM protocol_events; DELETE FROM sync_state; DELETE FROM messages; DELETE FROM conversation_participants; DELETE FROM participants; DELETE FROM conversations; DELETE FROM outbox;"
    );
  });

  afterAll(async () => {
    await dispose?.();
    await rm(configPath, { force: true });
  });

  test("applies migrations and enforces schema constraints", async () => {
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "messages",
        "outbox",
        "protocol_events",
        "sync_state",
      ])
    );
    await expect(
      db
        .prepare(
          "INSERT INTO messages (id, conversation_id, sender_id, external_id, text, transport, sent_at, outgoing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("m", "c", "s", "duplicate", "x", "sms", "2026-01-01", 0)
        .run()
    ).resolves.toBeTruthy();
    await expect(
      db
        .prepare(
          "INSERT INTO messages (id, conversation_id, sender_id, external_id, text, transport, sent_at, outgoing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind("m2", "c", "s", "duplicate", "x", "sms", "2026-01-01", 0)
        .run()
    ).rejects.toThrow();
  });

  test("persists rows, event cursor, and deduplicates a replay", async () => {
    const repository = await Effect.runPromise(
      Effect.provide(Effect.service(MessageRepository), services)
    );
    await Effect.runPromise(repository.ingestEvent(event));
    await Effect.runPromise(repository.ingestEvent(event));
    const messages = await db
      .prepare("SELECT id, external_id FROM messages")
      .all();
    const events = await db
      .prepare("SELECT external_id FROM protocol_events")
      .all();
    const cursor = await db
      .prepare("SELECT cursor FROM sync_state WHERE key = ?")
      .bind("google-messages-events")
      .first<{ cursor: string }>();
    expect(messages.results).toHaveLength(1);
    expect(events.results).toHaveLength(1);
    expect(cursor?.cursor).toBe("event-1");
  });

  test("reserves the outbox and preserves idempotency payload", async () => {
    const repository = await Effect.runPromise(
      Effect.provide(Effect.service(MessageRepository), services)
    );
    const reservation = await Effect.runPromise(
      repository.reserveIdempotencyKey("key", "conversation-1", "send")
    );
    expect(reservation).toMatchObject({ owner: expect.any(String) });
    if (reservation === false) {
      throw new Error("reservation was not acquired");
    }
    const pending = await db
      .prepare("SELECT status, owner FROM outbox WHERE idempotency_key = ?")
      .bind("key")
      .first();
    expect(pending).toMatchObject({
      owner: reservation.owner,
      status: "pending",
    });
    const outbox = await db
      .prepare(
        "SELECT status, external_id FROM outbox WHERE idempotency_key = ?"
      )
      .bind("key")
      .first<{ status: string; external_id: string }>();
    expect(outbox).toMatchObject({ external_id: null, status: "pending" });
    expect(
      await Effect.runPromise(
        repository.reserveIdempotencyKey("key", "conversation-1", "send")
      )
    ).toBe(false);
    await expect(
      Effect.runPromise(
        repository.reserveIdempotencyKey("key", "other-conversation", "send")
      )
    ).rejects.toThrow();
  });
});
