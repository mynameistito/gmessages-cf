import { describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect, Layer, Stream } from "effect";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import type { Message } from "../domain/message";
import {
  AccessAuthentication,
  accessAuthenticationLive,
  accessAuthenticationTest,
} from "../services/access-authentication";
import {
  GoogleMessagesError,
  GoogleMessages,
  GoogleMessagesTest,
} from "../services/google-messages";
import type { GoogleMessagesService } from "../services/google-messages";
import { MessagingService } from "../services/messaging-service";
import {
  MessageRepository,
  MessageRepositoryMemory,
} from "../services/repositories";
import { handleMcpRequest } from "../worker/mcp";
import worker from "../worker/worker";

const services = GoogleMessagesTest.pipe(
  Layer.merge(MessageRepositoryMemory.pipe(Layer.provide(GoogleMessagesTest)))
);

describe("fake Google Messages application", () => {
  test("reads fixtures and persists an outgoing message", async () => {
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* result() {
          const conversations = yield* MessagingService.listConversations;
          const message = yield* MessagingService.send(
            conversations[0]?.id ?? "missing",
            "hello",
            "hello-key"
          );
          const stored = yield* MessagingService.search("hello");
          return { message, stored };
        }),
        services
      )
    );
    expect(result.message.outgoing).toBe(true);
    expect(result.stored).toHaveLength(1);
  });
});

test("local authentication denies missing credentials and accepts the MCP token", async () => {
  const layer = accessAuthenticationTest({
    adminToken: "admin",
    serviceToken: "mcp",
  });
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* result() {
        const auth = yield* Effect.service(AccessAuthentication);
        const denied = yield* Effect.exit(auth.authenticate(new Headers()));
        const allowed = yield* auth.authenticate(
          new Headers({ "x-gmessages-test-token": "mcp" })
        );
        return { allowed, denied };
      }),
      layer
    )
  );
  expect(result.denied._tag).toBe("Failure");
  expect(result.allowed.type).toBe("service");
});

test("a repeated idempotency key returns the persisted delivery", async () => {
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* result() {
        const conversations = yield* MessagingService.listConversations;
        const conversationId = conversations[0]?.id ?? "missing";
        const first = yield* MessagingService.send(
          conversationId,
          "once",
          "same-key"
        );
        const second = yield* MessagingService.send(
          conversationId,
          "once",
          "same-key"
        );
        const stored = yield* MessagingService.search("once");
        return { first, second, stored };
      }),
      services
    )
  );
  expect(result.second.id).toBe(result.first.id);
  expect(result.stored).toHaveLength(1);
});

test("different idempotency keys do not collide for equal-length text", async () => {
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* result() {
        const conversations = yield* MessagingService.listConversations;
        const conversationId = conversations[0]?.id ?? "missing";
        const first = yield* MessagingService.send(
          conversationId,
          "same",
          "key-a"
        );
        const second = yield* MessagingService.send(
          conversationId,
          "same",
          "key-b"
        );
        return { first, second };
      }),
      services
    )
  );
  expect(result.first.id).not.toBe(result.second.id);
  expect(result.first.externalId).not.toBe(result.second.externalId);
});

test("rejects reusing an idempotency key with a different payload", async () => {
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* result() {
        const conversations = yield* MessagingService.listConversations;
        const conversationId = conversations[0]?.id ?? "missing";
        yield* MessagingService.send(conversationId, "original", "payload-key");
        return yield* Effect.exit(
          MessagingService.send(conversationId, "changed", "payload-key")
        );
      }),
      services
    )
  );

  expect(result._tag).toBe("Failure");
});

test("memory delivery ownership survives a reclaim and rejects stale completion", async () => {
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* result() {
        const repository = yield* Effect.service(MessageRepository);
        const provider = yield* Effect.service(GoogleMessages);
        const first = yield* repository.reserveIdempotencyKey(
          "reclaimed-key",
          "conversation-demo",
          "reclaimed"
        );
        if (first === false) {
          return yield* Effect.die("first reservation was not acquired");
        }
        const mismatch = yield* Effect.exit(
          repository.reserveIdempotencyKey(
            "reclaimed-key",
            "conversation-demo",
            "different"
          )
        );
        yield* repository.releaseIdempotencyKey("reclaimed-key", first.owner);
        const second = yield* repository.reserveIdempotencyKey(
          "reclaimed-key",
          "conversation-demo",
          "reclaimed"
        );
        if (second === false) {
          return yield* Effect.die("reclaimed reservation was not acquired");
        }
        const message = yield* provider.send(
          "conversation-demo",
          "reclaimed",
          "reclaimed-key"
        );
        const stale = yield* Effect.exit(
          repository.commitDelivery("reclaimed-key", first.owner, message)
        );
        yield* repository.commitDelivery(
          "reclaimed-key",
          second.owner,
          message
        );
        return { message, mismatch, stale };
      }),
      services
    )
  );

  expect(result.mismatch._tag).toBe("Failure");
  expect(result.stale._tag).toBe("Failure");
  expect(result.message.text).toBe("reclaimed");
});

test("a provider failure releases the idempotency reservation", async () => {
  const failingProvider = Layer.succeed(GoogleMessages, {
    connect: Effect.void,
    conversations: Effect.succeed([]),
    events: Stream.empty,
    messages: () => Effect.succeed([]),
    send: () =>
      Effect.fail(
        new GoogleMessagesError({
          reason: "provider unavailable",
          retryable: true,
        })
      ),
  } satisfies GoogleMessagesService);
  const failingServices = failingProvider.pipe(
    Layer.merge(MessageRepositoryMemory.pipe(Layer.provide(failingProvider)))
  );
  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* result() {
        const first = yield* Effect.exit(
          MessagingService.send("conversation-demo", "retry", "retry-key")
        );
        const second = yield* Effect.exit(
          MessagingService.send("conversation-demo", "retry", "retry-key")
        );
        return { first, second };
      }),
      failingServices
    )
  );
  expect(result.first._tag).toBe("Failure");
  expect(result.second._tag).toBe("Failure");
});

test("a retry after a provider failure can complete the delivery", async () => {
  let attempts = 0;
  const provider = Layer.succeed(GoogleMessages, {
    connect: Effect.void,
    conversations: Effect.succeed([]),
    events: Stream.empty,
    messages: () => Effect.succeed([]),
    send: (conversationId, text, _idempotencyKey) => {
      attempts += 1;
      return attempts === 1
        ? Effect.fail(
            new GoogleMessagesError({ reason: "temporary", retryable: true })
          )
        : Effect.succeed({
            // SAFETY: test identifier satisfies the branded domain identifier contract.
            conversationId: conversationId as Message["conversationId"],
            externalId: "retry-message",
            // SAFETY: test identifier satisfies the branded domain identifier contract.
            id: "retry-message" as Message["id"],
            outgoing: true,
            // SAFETY: test identifier satisfies the branded domain identifier contract.
            senderId: "sender-1" as Message["senderId"],
            sentAt: new Date(),
            text,
            transport: "rcs" as const,
          });
    },
  } satisfies GoogleMessagesService);
  const retryServices = provider.pipe(
    Layer.merge(MessageRepositoryMemory.pipe(Layer.provide(provider)))
  );

  const result = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* result() {
        const first = yield* Effect.exit(
          MessagingService.send("conversation-demo", "retry", "retry-once")
        );
        const second = yield* MessagingService.send(
          "conversation-demo",
          "retry",
          "retry-once"
        );
        return { first, second };
      }),
      retryServices
    )
  );

  expect(result.first._tag).toBe("Failure");
  expect(result.second.externalId).toBe("retry-message");
});

test("health is not a public debug endpoint", async () => {
  const denied = await worker.fetch(new Request("https://example.test/health"));
  const allowed = await worker.fetch(
    new Request("https://example.test/health", {
      headers: { "x-gmessages-test-token": "local-mcp-token" },
    })
  );
  expect(denied.status).toBe(401);
  expect(allowed.status).toBe(200);
  expect(await allowed.text()).not.toContain("token");
});

test("MCP rejects missing and invalid local authentication", async () => {
  const missing = await worker.fetch(new Request("https://example.test/mcp"));
  const invalid = await worker.fetch(
    new Request("https://example.test/mcp", {
      headers: { "x-gmessages-test-token": "invalid" },
    })
  );
  expect(missing.status).toBe(401);
  expect(invalid.status).toBe(401);
});

test("deployed authentication never falls back to the local token", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/health", {
      headers: { "x-gmessages-test-token": "local-mcp-token" },
    }),
    { GMESSAGES_AUTH_MODE: "access" }
  );
  expect(response.status).toBe(503);
});

test("deployed authentication rejects empty Access configuration", async () => {
  const response = await worker.fetch(
    new Request("https://example.test/health", {
      headers: { "x-gmessages-test-token": "local-mcp-token" },
    }),
    {
      GMESSAGES_ACCESS_AUDIENCE: "",
      GMESSAGES_ACCESS_TEAM_DOMAIN: "https://team.example.com",
      GMESSAGES_AUTH_MODE: "access",
    }
  );
  expect(response.status).toBe(503);
});

test("Access authentication validates signature, issuer, audience, and expiry", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (input.toString().endsWith("/cdn-cgi/access/certs")) {
        return Promise.resolve(Response.json({ keys: [jwk] }));
      }
      return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect }
  );
  try {
    const authLayer = accessAuthenticationLive({
      audience: "expected-audience",
      teamDomain: "https://team.example.com",
    });
    const auth = await Effect.runPromise(
      Effect.provide(Effect.service(AccessAuthentication), authLayer)
    );
    const token = (claims: { aud: string; exp?: number; iss: string }) =>
      new SignJWT({ sub: "user-1" })
        .setProtectedHeader({ alg: "ES256", kid: "test-key" })
        .setIssuer(claims.iss)
        .setAudience(claims.aud)
        .setIssuedAt()
        .setExpirationTime(claims.exp ?? "1h")
        .sign(privateKey);
    const valid = await Effect.runPromise(
      auth.authenticate(
        new Headers({
          "cf-access-jwt-assertion": await token({
            aud: "expected-audience",
            iss: "https://team.example.com",
          }),
        })
      )
    );
    expect(valid.subject).toBe("user-1");
    const results = await Promise.all(
      [
        { aud: "wrong-audience", iss: "https://team.example.com" },
        { aud: "expected-audience", iss: "https://other.example.com" },
        {
          aud: "expected-audience",
          exp: Math.floor(Date.now() / 1000) - 1,
          iss: "https://team.example.com",
        },
      ].map(async (claims) =>
        Effect.runPromiseExit(
          auth.authenticate(
            new Headers({
              "cf-access-jwt-assertion": await token(claims),
            })
          )
        )
      )
    );
    for (const result of results) {
      expect(result._tag).toBe("Failure");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP client can initialize, list, read, search, and send", async () => {
  const client = new Client({ name: "fake-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://example.test/mcp"),
    {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("accept", "application/json, text/event-stream");
        headers.set("x-gmessages-test-token", "local-mcp-token");
        const url = input.toString();
        return worker.fetch(new Request(url, { ...init, headers }));
      },
    }
  );
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toContain(
    "messages.list_conversations"
  );
  const conversations = await client.callTool({
    arguments: {},
    name: "messages.list_conversations",
  });
  expect(conversations.isError).not.toBe(true);
  const conversationId = "conversation-demo";
  const message = await client.callTool({
    arguments: { conversationId, idempotencyKey: "mcp-key", text: "mcp hello" },
    name: "messages.send",
  });
  expect(message.isError).not.toBe(true);
  const invalid = await client.callTool({
    arguments: { conversationId: "", idempotencyKey: "bad-key", text: "" },
    name: "messages.send",
  });
  expect(invalid.isError).toBe(true);
  await client.close();
});

test("MCP returns provider failures as non-empty tool errors", async () => {
  const failingProvider = Layer.succeed(GoogleMessages, {
    connect: Effect.fail(
      new GoogleMessagesError({
        reason: "provider unavailable",
        retryable: true,
      })
    ),
    conversations: Effect.succeed([]),
    events: Stream.empty,
    messages: () => Effect.succeed([]),
    send: () => Effect.die("send is not exercised by this test"),
  } satisfies GoogleMessagesService);
  const failingServices = failingProvider.pipe(
    Layer.merge(MessageRepositoryMemory.pipe(Layer.provide(failingProvider)))
  );
  const client = new Client({ name: "failing-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("https://example.test/mcp"),
    {
      fetch: (input, init) =>
        handleMcpRequest(new Request(input.toString(), init), failingServices),
    }
  );

  await client.connect(transport);
  const result = await client.callTool({
    arguments: {},
    name: "messages.list_conversations",
  });

  expect(result.isError).toBe(true);
  expect(result.content).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ text: "provider unavailable", type: "text" }),
    ])
  );
  await client.close();
});
