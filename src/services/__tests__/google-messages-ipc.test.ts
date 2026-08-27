// oxlint-disable no-unused-vars
// oxlint-disable require-await
// oxlint-disable promise/prefer-await-to-callbacks
// oxlint-disable unicorn/no-await-expression-member
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion
// oxlint-disable anti-slop/no-chained-type-assertions

import { expect, test } from "bun:test";

import { Effect, Redacted, Stream } from "effect";

import { GoogleMessages } from "../google-messages";
import { googleMessagesIpc } from "../google-messages-ipc";

const wire = (id: string, text = "hello") =>
  `id: ${id}\ndata: ${JSON.stringify({ conversationId: "c", externalId: id, id, outgoing: false, senderId: "s", sentAt: "2026-01-01T00:00:00.000Z", text, transport: "sms" })}\n\n`;
const provider = (fetcher: (request: Request) => Promise<Response>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.service(GoogleMessages),
      googleMessagesIpc({
        baseUrl: new URL("https://container/"),
        fetcher,
        token: Redacted.make("ipc-test-token"),
      })
    )
  );

test("validates IPC requests and SSE events without credentials", async () => {
  const requests: Request[] = [];
  const service = await provider(async (request) => {
    requests.push(request);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(wire("event-1")));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  });
  const events = await Effect.runPromise(
    Stream.runCollect(Stream.take(service.events, 1))
  );
  expect(events[0]?.id).toBe("event-1");
  expect(requests[0]?.headers.get("authorization")).toBe(
    "Bearer ipc-test-token"
  );
});

test("ignores malformed events and reconnects with Last-Event-ID", async () => {
  const headers: string[] = [];
  let connection = 0;
  const service = await provider(async (request) => {
    headers.push(request.headers.get("last-event-id") ?? "");
    connection += 1;
    const body =
      connection === 1 ? `data: {bad}\n\n${wire("event-1")}` : wire("event-2");
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    const events = await Effect.runPromise(
      Stream.runCollect(Stream.take(service.events, 2))
    );
    expect(events.map((event) => event.id)).toEqual(["event-1", "event-2"]);
    expect(headers).toEqual(["", "event-1"]);
  } finally {
    globalThis.setTimeout = original;
  }
});

test("keeps SSE readers sequential when a stream reconnects", async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const service = await provider(async () => {
    calls += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire(`event-${calls}`)));
        controller.close();
        active -= 1;
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const original = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void) => {
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    await Effect.runPromise(Stream.runCollect(Stream.take(service.events, 2)));
  } finally {
    globalThis.setTimeout = original;
  }
  expect(maximum).toBe(1);
});
