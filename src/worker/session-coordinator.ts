import type {
  DurableObjectNamespace,
  DurableObjectState,
} from "@cloudflare/workers-types";
import { Schema } from "effect";

interface SessionCoordinatorEnv {
  readonly CONTAINER?: DurableObjectNamespace;
}

interface CoordinatorStatus {
  readonly lastActivityAt: string | null;
  readonly requestCount: number;
}

interface SessionEnvelope {
  readonly ciphertext: string;
}

interface SendWindow {
  readonly timestamps: readonly number[];
}

const SessionEnvelopeSchema = Schema.Struct({ ciphertext: Schema.String });
const PairingStatusSchema = Schema.Struct({
  paired: Schema.optional(Schema.Boolean),
  pairing: Schema.optional(Schema.Boolean),
});
const sendWindowKey = "send-window";
const pairingActiveKey = "pairing-active";
const sendWindowMs = 60_000;
const sendLimit = 10;

/** Durable Object reserved for single-session ownership and serialized reconnects. */
export class SessionCoordinator {
  private readonly state: DurableObjectState;
  private readonly env: SessionCoordinatorEnv;

  constructor(state: DurableObjectState, env: SessionCoordinatorEnv) {
    this.state = state;
    this.env = env;
  }

  fetch(request: Request): Promise<Response> {
    // The request pipeline is intentionally kept together to serialize this session owner.
    // eslint-disable-next-line complexity
    return this.state.blockConcurrencyWhile(async () => {
      const url = new URL(request.url);
      const status = (await this.state.storage.get<CoordinatorStatus>(
        "status"
      )) ?? {
        lastActivityAt: null,
        requestCount: 0,
      };
      const sessionEnvelope =
        await this.state.storage.get<SessionEnvelope>("session-envelope");
      const isPairingRequest = url.pathname.startsWith("/v1/pair/");
      const isPairingStatus = url.pathname === "/v1/pair/status";
      const pairingActive =
        (await this.state.storage.get<boolean>(pairingActiveKey)) ?? false;
      if (url.pathname !== "/status" && !url.pathname.startsWith("/v1/")) {
        return new Response("Not found", { status: 404 });
      }
      if (
        url.pathname !== "/status" &&
        !["GET", "POST"].includes(request.method)
      ) {
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === "/status") {
        return Response.json({
          lastActivityAt: status.lastActivityAt,
          owner: this.state.id.toString(),
          requestCount: status.requestCount,
          session: "primary",
          sessionPersisted: sessionEnvelope !== undefined,
          status: "ready",
        });
      }
      if (request.method === "POST" && url.pathname.endsWith("/messages")) {
        const now = Date.now();
        const window =
          (await this.state.storage.get<SendWindow>(sendWindowKey)) ??
          ({ timestamps: [] } satisfies SendWindow);
        const timestamps = window.timestamps.filter(
          (timestamp) => now - timestamp < sendWindowMs
        );
        if (timestamps.length >= sendLimit) {
          return new Response("Send rate limit exceeded", {
            headers: { "retry-after": "60" },
            status: 429,
          });
        }
        await this.state.storage.put<SendWindow>(sendWindowKey, {
          timestamps: [...timestamps, now],
        });
      }
      const container = this.env.CONTAINER;
      if (container === undefined) {
        return new Response("Container binding is not configured", {
          status: 503,
        });
      }
      await this.state.storage.put<CoordinatorStatus>("status", {
        lastActivityAt: new Date().toISOString(),
        requestCount: status.requestCount + 1,
      });
      try {
        if (
          sessionEnvelope !== undefined &&
          (!isPairingRequest || (isPairingStatus && !pairingActive))
        ) {
          const imported = await SessionCoordinator.forward(
            new globalThis.Request(
              new URL("/v1/session/import", request.url).toString(),
              {
                body: JSON.stringify(sessionEnvelope),
                headers: request.headers,
                method: "POST",
              }
            ),
            container
          );
          if (!imported.ok) {
            return new Response("Session recovery failed", { status: 503 });
          }
        }
        if (
          isPairingRequest &&
          request.method === "POST" &&
          url.pathname.endsWith("/start")
        ) {
          await this.state.storage.put(pairingActiveKey, true);
        }
        const response = await SessionCoordinator.forward(request, container);
        let pairingCompleted = false;
        let pairingStillActive = false;
        if (isPairingStatus && response.ok) {
          try {
            const body = Schema.decodeUnknownSync(PairingStatusSchema)(
              await response.clone().json()
            );
            pairingCompleted = body.paired === true;
            pairingStillActive = body.pairing === true;
          } catch {
            pairingCompleted = false;
          }
          if (pairingActive && !pairingStillActive) {
            await this.state.storage.delete(pairingActiveKey);
          }
        }
        if (response.ok && (!isPairingRequest || pairingCompleted)) {
          const exported = await SessionCoordinator.forward(
            new globalThis.Request(
              new URL("/v1/session/export", request.url).toString(),
              { headers: request.headers }
            ),
            container
          );
          if (exported.ok) {
            const envelope = Schema.decodeUnknownSync(SessionEnvelopeSchema)(
              await exported.json()
            );
            if (envelope.ciphertext.length > 0) {
              await this.state.storage.put("session-envelope", envelope);
            }
          }
        }
        return response;
      } catch {
        return new Response("Session provider unavailable", { status: 503 });
      }
    });
  }

  private static async forward(
    request: Request,
    container: DurableObjectNamespace
  ): Promise<Response> {
    const response = await container.getByName("primary").fetch(request.url, {
      body: request.body,
      headers: request.headers,
      method: request.method,
    });
    return new globalThis.Response(response.body, {
      headers: [...response.headers.entries()],
      status: response.status,
    });
  }
}
