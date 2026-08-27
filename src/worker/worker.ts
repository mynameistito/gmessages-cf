import type {
  D1Database,
  DurableObjectNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";
import { Effect, Layer, Redacted, Stream } from "effect";

import {
  AccessAuthentication,
  accessAuthenticationLive,
  accessAuthenticationTest,
} from "../services/access-authentication";
import { messageRepositoryD1 } from "../services/d1-repository";
import {
  GoogleMessages,
  GoogleMessagesTest,
} from "../services/google-messages";
import { googleMessagesIpc } from "../services/google-messages-ipc";
import {
  MessageRepository,
  MessageRepositoryMemory,
} from "../services/repositories";
import { d1Live } from "../services/storage";
import { handleMcpRequest } from "./mcp";

const fakeServices = GoogleMessagesTest.pipe(
  Layer.merge(MessageRepositoryMemory.pipe(Layer.provide(GoogleMessagesTest)))
);
const localAuth = accessAuthenticationTest({
  adminToken: "local-admin-token",
  serviceToken: "local-mcp-token",
});

let eventConsumerStarted = false;

const selectAuthenticationLayer = (env: WorkerEnv) => {
  if (env.GMESSAGES_AUTH_MODE !== "access") {
    return localAuth;
  }
  if (
    env.GMESSAGES_ACCESS_AUDIENCE === undefined ||
    env.GMESSAGES_ACCESS_AUDIENCE.length === 0 ||
    env.GMESSAGES_ACCESS_TEAM_DOMAIN === undefined ||
    env.GMESSAGES_ACCESS_TEAM_DOMAIN.length === 0
  ) {
    return;
  }
  return accessAuthenticationLive({
    audience: env.GMESSAGES_ACCESS_AUDIENCE,
    teamDomain: env.GMESSAGES_ACCESS_TEAM_DOMAIN,
  });
};

const handlePairingRequest = async (
  request: Request,
  env: WorkerEnv,
  isUser: boolean
): Promise<Response> => {
  if (!isUser) {
    return new Response("Forbidden", { status: 403 });
  }
  if (env.GMESSAGES_MODE !== "real") {
    return new Response("Pairing requires real mode", { status: 409 });
  }
  if (env.SESSION_COORDINATOR === undefined) {
    return new Response("Pairing is not configured", { status: 503 });
  }
  if (env.GMESSAGES_IPC_TOKEN === undefined) {
    return new Response("Pairing authentication is not configured", {
      status: 503,
    });
  }
  const coordinator = env.SESSION_COORDINATOR.getByName("primary");
  const path = new URL(request.url).pathname.slice("/admin/pair".length);
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${env.GMESSAGES_IPC_TOKEN}`);
  const response = await coordinator.fetch(
    new URL(`/v1/pair${path}`, request.url).toString(),
    {
      body: request.body,
      headers,
      method: request.method,
    }
  );
  return new globalThis.Response(await response.arrayBuffer(), {
    headers: [...response.headers.entries()],
    status: response.status,
  });
};

interface WorkerEnv {
  readonly ATTACHMENTS?: R2Bucket;
  readonly CONTAINER?: DurableObjectNamespace;
  readonly DB?: D1Database;
  readonly GMESSAGES_IPC_TOKEN?: string;
  readonly GMESSAGES_ACCESS_AUDIENCE?: string;
  readonly GMESSAGES_ACCESS_TEAM_DOMAIN?: string;
  readonly GMESSAGES_AUTH_MODE?: string;
  readonly GMESSAGES_MODE?: string;
  readonly SESSION_COORDINATOR?: DurableObjectNamespace;
}

/** Cloudflare Worker entrypoint for the fake-mode vertical slice. */
export default {
  async fetch(request: Request, env: WorkerEnv = {}): Promise<Response> {
    const url = new URL(request.url);
    const authenticationLayer = selectAuthenticationLayer(env);
    if (authenticationLayer === undefined) {
      return new Response("Access authentication is not configured", {
        status: 503,
      });
    }
    const authentication = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function* authentication() {
          const auth = yield* Effect.service(AccessAuthentication);
          return yield* auth.authenticate(request.headers);
        }),
        authenticationLayer
      )
    );
    if (authentication._tag === "Failure") {
      return new Response("Unauthorized", { status: 401 });
    }
    if (url.pathname === "/health") {
      return Response.json({
        container: "fake",
        paired: false,
        status: "healthy",
      });
    }
    if (url.pathname.startsWith("/admin/pair/")) {
      return handlePairingRequest(
        request,
        env,
        authentication.value.type === "user"
      );
    }
    if (url.pathname.startsWith("/attachments/")) {
      const attachmentId = url.pathname.slice("/attachments/".length);
      const bucket = env.ATTACHMENTS;
      if (bucket === undefined || attachmentId.length === 0) {
        return new Response("Not found", { status: 404 });
      }
      const object = await bucket.get(attachmentId);
      return object === null
        ? new Response("Not found", { status: 404 })
        : new Response(object.body, {
            headers: {
              "content-type":
                object.httpMetadata?.contentType ?? "application/octet-stream",
            },
          });
    }
    if (url.pathname !== "/mcp") {
      return new Response("Not found", { status: 404 });
    }
    if (env.GMESSAGES_MODE === "real") {
      if (
        env.SESSION_COORDINATOR === undefined ||
        env.GMESSAGES_IPC_TOKEN === undefined ||
        env.DB === undefined
      ) {
        return new Response("Real mode is not configured", { status: 503 });
      }
      const coordinator = env.SESSION_COORDINATOR.getByName("primary");
      const provider = googleMessagesIpc({
        baseUrl: new URL("https://container/"),
        fetcher: async (coordinatorRequest) => {
          const response = await coordinator.fetch(coordinatorRequest.url, {
            body: coordinatorRequest.body,
            headers: coordinatorRequest.headers,
            method: coordinatorRequest.method,
          });
          return new globalThis.Response(await response.arrayBuffer(), {
            headers: [...response.headers.entries()],
            status: response.status,
          });
        },
        token: Redacted.make(env.GMESSAGES_IPC_TOKEN),
      });
      const realServices = provider.pipe(
        Layer.merge(messageRepositoryD1().pipe(Layer.provide(d1Live(env.DB))))
      );
      if (!eventConsumerStarted) {
        eventConsumerStarted = true;
        Effect.runFork(
          Effect.gen(function* consumeEvents() {
            const realProvider = yield* Effect.service(GoogleMessages);
            const repository = yield* Effect.service(MessageRepository);
            yield* Stream.runForEach(realProvider.events, (event) =>
              repository.ingestEvent(event)
            );
          }).pipe(Effect.provide(realServices))
        );
      }
      return handleMcpRequest(request, realServices);
    }
    return handleMcpRequest(request, fakeServices);
  },
};
