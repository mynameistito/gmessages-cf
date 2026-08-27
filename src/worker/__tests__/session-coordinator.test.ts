// oxlint-disable promise/prefer-await-to-callbacks
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion
// oxlint-disable anti-slop/no-chained-type-assertions
// oxlint-disable anti-slop/no-runtime-typeof

import { describe, expect, test } from "bun:test";

import type {
  DurableObjectNamespace,
  DurableObjectState,
  DurableObjectStorage,
} from "@cloudflare/workers-types";

import { SessionCoordinator } from "../session-coordinator";

class StorageDouble {
  private readonly values = new Map<string, unknown>();

  readonly storage = {
    get: <T>(key: string) =>
      Promise.resolve(this.values.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      this.values.set(key, value);
      return Promise.resolve();
    },
  } as Pick<DurableObjectStorage, "get" | "put">;
}

const makeState = (
  storage: Pick<DurableObjectStorage, "get" | "put">
): DurableObjectState => {
  const state = {
    blockConcurrencyWhile: async <T>(callback: () => Promise<T>) =>
      await callback(),
    id: { equals: () => true, toString: () => "primary" },
    storage,
  };
  // SAFETY: the coordinator only accesses these mocked state members.
  return state as unknown as DurableObjectState;
};

const makeContainer = (ciphertext: string, calls: string[]) => {
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request =
      input instanceof Request
        ? new Request(input, init)
        : new Request(input.toString(), init);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    if (new URL(request.url).pathname === "/v1/session/import") {
      const body = JSON.stringify(await request.json());
      return new Response(null, {
        status: body.includes(`"ciphertext":"${ciphertext}"`) ? 200 : 400,
      });
    }
    if (new URL(request.url).pathname === "/v1/session/export") {
      return Response.json({ ciphertext });
    }
    return Response.json({ connected: true }, { status: 200 });
  };
  const namespace = {
    getByName: () => ({ fetch }),
  };
  // SAFETY: the coordinator only calls getByName().fetch() on this double.
  return namespace as unknown as DurableObjectNamespace;
};

const makeCoordinator = (
  storage: Pick<DurableObjectStorage, "get" | "put">,
  ciphertext: string,
  calls: string[]
) =>
  new SessionCoordinator(makeState(storage), {
    CONTAINER: makeContainer(ciphertext, calls),
  });

describe("session coordinator recovery", () => {
  test("imports the encrypted envelope after a coordinator restart", async () => {
    const storage = new StorageDouble();
    const firstCalls: string[] = [];
    const first = makeCoordinator(
      storage.storage,
      "valid-ciphertext",
      firstCalls
    );

    const initial = await first.fetch(
      new Request("https://example.test/v1/connect", { method: "POST" })
    );
    expect(initial.status).toBe(200);

    const replacementCalls: string[] = [];
    const replacement = makeCoordinator(
      storage.storage,
      "valid-ciphertext",
      replacementCalls
    );
    const recovered = await replacement.fetch(
      new Request("https://example.test/v1/conversations", { method: "GET" })
    );

    expect(recovered.status).toBe(200);
    expect(replacementCalls[0]).toBe("POST /v1/session/import");
    expect(replacementCalls).toContain("GET /v1/conversations");
  });

  test("rejects a tampered envelope before calling the provider", async () => {
    const storage = new StorageDouble();
    await storage.storage.put("session-envelope", { ciphertext: "tampered" });
    const calls: string[] = [];
    const coordinator = makeCoordinator(
      storage.storage,
      "valid-ciphertext",
      calls
    );

    const response = await coordinator.fetch(
      new Request("https://example.test/v1/conversations", { method: "GET" })
    );

    expect(response.status).toBe(503);
    expect(calls).toEqual(["POST /v1/session/import"]);
  });

  test("limits sends per session", async () => {
    const storage = new StorageDouble();
    const calls: string[] = [];
    const coordinator = makeCoordinator(
      storage.storage,
      "valid-ciphertext",
      calls
    );
    const request = () =>
      coordinator.fetch(
        new Request("https://example.test/v1/conversations/demo/messages", {
          body: "{}",
          method: "POST",
        })
      );

    for (let index = 0; index < 10; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- verifies serialized window updates.
      const response = await request();
      expect(response.status).toBe(200);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });
});
