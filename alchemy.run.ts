import { Stage, Stack } from "alchemy";
import { providers, state } from "alchemy/Cloudflare";
import { Application, Policy, ServiceToken } from "alchemy/Cloudflare/Access";
import { Container } from "alchemy/Cloudflare/Containers";
import { Database } from "alchemy/Cloudflare/D1";
import { Bucket } from "alchemy/Cloudflare/R2";
import { DurableObject, Worker } from "alchemy/Cloudflare/Workers";
import { redacted, string, withDefault } from "effect/Config";
import { gen } from "effect/Effect";

export default Stack(
  "gmessages-cf",
  {
    providers: providers(),
    state: state(),
  },
  gen(function* infrastructure() {
    const stage = yield* Stage;
    const hostname = yield* string("GMESSAGES_HOSTNAME").pipe(withDefault(""));
    const adminHostname =
      stage === "production"
        ? yield* string("GMESSAGES_ADMIN_HOSTNAME")
        : yield* string("GMESSAGES_ADMIN_HOSTNAME").pipe(withDefault(""));
    const adminEmail =
      stage === "production"
        ? yield* string("GMESSAGES_ADMIN_EMAIL")
        : yield* string("GMESSAGES_ADMIN_EMAIL").pipe(withDefault(""));
    const accessAudience =
      stage === "production"
        ? yield* string("GMESSAGES_ACCESS_AUDIENCE")
        : yield* string("GMESSAGES_ACCESS_AUDIENCE").pipe(
            withDefault("local-development")
          );
    const accessTeamDomain =
      stage === "production"
        ? yield* string("GMESSAGES_ACCESS_TEAM_DOMAIN")
        : yield* string("GMESSAGES_ACCESS_TEAM_DOMAIN").pipe(
            withDefault("https://local-development.invalid")
          );
    const authMode = yield* string("GMESSAGES_AUTH_MODE").pipe(
      withDefault(stage === "production" ? "access" : "test")
    );
    const mode = yield* string("GMESSAGES_MODE").pipe(withDefault("fake"));
    const ipcToken =
      stage === "production"
        ? yield* redacted("GMESSAGES_IPC_TOKEN")
        : yield* redacted("GMESSAGES_IPC_TOKEN").pipe(
            withDefault("local-dev-ipc-token")
          );
    const sessionKey =
      stage === "production"
        ? yield* redacted("GMESSAGES_SESSION_KEY")
        : yield* redacted("GMESSAGES_SESSION_KEY").pipe(
            withDefault("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
          );
    const database = yield* Database("MessagesDatabase", {
      migrations: "./migrations",
      name: `gmessages-${stage}`,
    });
    const bucket = yield* Bucket("AttachmentsBucket", {
      name: `gmessages-attachments-${stage}`,
    });
    const session = DurableObject("SessionCoordinator", {
      className: "SessionCoordinator",
    });
    const container = Container("GoogleMessagesContainer", {
      className: "GoogleMessagesContainer",
      context: ".",
      dockerfile: "Dockerfile",
      env: {
        LIBGM_IPC_TOKEN: ipcToken,
        LIBGM_SESSION_KEY: sessionKey,
      },
      maxInstances: 1,
    });
    const serviceToken =
      hostname.length === 0
        ? undefined
        : yield* ServiceToken("McpServiceToken", {
            duration: "8760h",
            name: `gmessages-mcp-${stage}`,
          });
    const servicePolicy =
      serviceToken === undefined
        ? undefined
        : yield* Policy("McpServicePolicy", {
            decision: "non_identity",
            include: [
              { serviceToken: { tokenId: serviceToken.serviceTokenId } },
            ],
          });
    const access =
      hostname.length === 0
        ? undefined
        : yield* Application("McpAccess", {
            domain: hostname,
            policies: servicePolicy === undefined ? [] : [servicePolicy],
            sessionDuration: "24h",
            type: "self_hosted",
          });
    const adminPolicy =
      adminHostname.length === 0 || adminEmail.length === 0
        ? undefined
        : yield* Policy("AdminPairingPolicy", {
            decision: "allow",
            include: [{ email: adminEmail }],
          });
    const adminAccess =
      adminHostname.length === 0 || adminPolicy === undefined
        ? undefined
        : yield* Application("AdminAccess", {
            domain: adminHostname,
            policies: [adminPolicy],
            sessionDuration: "1h",
            type: "self_hosted",
          });
    const worker = yield* Worker("MessagesWorker", {
      access,
      domain:
        hostname.length === 0
          ? undefined
          : {
              aliases: adminHostname.length === 0 ? [] : [adminHostname],
              name: hostname,
            },
      env: {
        ATTACHMENTS: bucket,
        CONTAINER: container,
        DB: database,
        GMESSAGES_ACCESS_AUDIENCE: accessAudience,
        GMESSAGES_ACCESS_TEAM_DOMAIN: accessTeamDomain,
        GMESSAGES_ADMIN_HOSTNAME: adminHostname,
        GMESSAGES_AUTH_MODE: authMode,
        GMESSAGES_HOSTNAME: hostname,
        GMESSAGES_IPC_TOKEN: ipcToken,
        GMESSAGES_MODE: mode,
        SESSION_COORDINATOR: session,
      },
      main: "./src/worker/entrypoint.ts",
      workersDev: false,
    });
    return {
      access,
      adminAccess,
      bucket,
      container,
      database,
      serviceToken,
      session,
      worker,
    };
  })
);
