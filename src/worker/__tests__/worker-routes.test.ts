// oxlint-disable no-unused-vars
// oxlint-disable require-await
// oxlint-disable unicorn/no-await-expression-member
// oxlint-disable anti-slop/require-safety-comment-for-type-assertion
// oxlint-disable anti-slop/no-chained-type-assertions

import { expect, test } from "bun:test";

import type { R2Bucket } from "@cloudflare/workers-types";

import worker from "../worker";

const request = (path: string, token = "local-mcp-token", init?: RequestInit) =>
  worker.fetch(
    new Request(`https://mcp.example.test${path}`, {
      ...init,
      headers: { ...init?.headers, "x-gmessages-test-token": token },
    }),
    { GMESSAGES_AUTH_MODE: "test", GMESSAGES_HOSTNAME: "mcp.example.test" }
  );

test("auth mode and health lifecycle matrix", async () => {
  expect(
    (await worker.fetch(new Request("https://mcp.example.test/health"), {}))
      .status
  ).toBe(503);
  expect((await request("/health")).status).toBe(200);
  expect((await request("/health", "wrong-token")).status).toBe(401);
  expect(await (await request("/health")).json()).toEqual({
    container: "fake",
    paired: false,
    status: "healthy",
  });
  expect(
    (
      await worker.fetch(new Request("https://mcp.example.test/health"), {
        GMESSAGES_ACCESS_AUDIENCE: "a",
        GMESSAGES_ACCESS_TEAM_DOMAIN: "https://team.example",
        GMESSAGES_AUTH_MODE: "access",
      })
    ).status
  ).toBe(401);
});

test("MCP authorization, attachments, pairing, and missing real bindings are explicit", async () => {
  expect(
    (await request("/mcp", "local-mcp-token", { method: "GET" })).status
  ).not.toBe(403);
  expect(
    (
      await worker.fetch(
        new Request("https://other.example.test/mcp", {
          headers: { "x-gmessages-test-token": "local-mcp-token" },
        }),
        { GMESSAGES_AUTH_MODE: "test", GMESSAGES_HOSTNAME: "mcp.example.test" }
      )
    ).status
  ).toBe(403);
  expect((await request("/attachments/missing")).status).toBe(404);
  expect(
    (
      await worker.fetch(
        new Request("https://mcp.example.test/admin/pair/start", {
          headers: { "x-gmessages-test-token": "local-admin-token" },
          method: "POST",
        }),
        {
          GMESSAGES_ADMIN_HOSTNAME: "admin.example.test",
          GMESSAGES_AUTH_MODE: "test",
        }
      )
    ).status
  ).toBe(403);
  expect(
    (
      await worker.fetch(
        new Request("https://admin.example.test/admin/pair/start", {
          headers: { "x-gmessages-test-token": "local-admin-token" },
          method: "POST",
        }),
        {
          GMESSAGES_ADMIN_HOSTNAME: "admin.example.test",
          GMESSAGES_AUTH_MODE: "test",
        }
      )
    ).status
  ).toBe(409);
  expect(
    (
      await worker.fetch(
        new Request("https://mcp.example.test/mcp", {
          headers: { "x-gmessages-test-token": "local-mcp-token" },
          method: "GET",
        }),
        { GMESSAGES_AUTH_MODE: "test", GMESSAGES_MODE: "real" }
      )
    ).status
  ).toBe(503);
});

test("serves private attachment bytes only when the object exists", async () => {
  const bucket = {
    get: async (key: string) =>
      key === "file"
        ? {
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("bytes"));
                controller.close();
              },
            }),
            httpMetadata: { contentType: "text/plain" },
          }
        : null,
  } as unknown as R2Bucket;
  const response = await worker.fetch(
    new Request("https://mcp.example.test/attachments/file", {
      headers: { "x-gmessages-test-token": "local-mcp-token" },
    }),
    { ATTACHMENTS: bucket, GMESSAGES_AUTH_MODE: "test" }
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("bytes");
  expect(response.headers.get("cache-control")).toBe("no-store");
});
