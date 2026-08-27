import { Context, Effect, Layer, Schema } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { AuthenticationError } from "./authentication-error";

/** Authenticated caller identity. */
export const AccessPrincipalSchema = Schema.Struct({
  subject: Schema.String,
  type: Schema.Union([Schema.Literal("service"), Schema.Literal("user")]),
});
export type AccessPrincipal = Schema.Schema.Type<typeof AccessPrincipalSchema>;

/** Authentication service contract. */
export interface AccessAuthenticationService {
  readonly authenticate: (
    headers: Headers
  ) => Effect.Effect<AccessPrincipal, AuthenticationError>;
}

/** Authentication failure. */
/** Validates the edge assertion and produces an application principal. */
export class AccessAuthentication extends Context.Service<
  AccessAuthentication,
  AccessAuthenticationService
>()("gmessages/AccessAuthentication") {}

/** Deterministic local authentication; unlike an auth bypass, missing credentials are denied. */
export const accessAuthenticationTest = (options: {
  readonly serviceToken: string;
  readonly adminToken: string;
}) =>
  Layer.succeed(AccessAuthentication, {
    authenticate: (headers) =>
      Effect.gen(function* authenticate() {
        const token = headers.get("x-gmessages-test-token");
        if (token === null) {
          return yield* Effect.fail(
            new AuthenticationError({ reason: "missing" })
          );
        }
        if (token === options.adminToken) {
          return { subject: "local-admin", type: "user" };
        }
        if (token === options.serviceToken) {
          return { subject: "local-mcp", type: "service" };
        }
        return yield* Effect.fail(
          new AuthenticationError({ reason: "invalid" })
        );
      }),
  });

/** Configuration required to validate Cloudflare Access application tokens. */
export interface AccessAuthenticationOptions {
  readonly audience: string;
  readonly teamDomain: string;
}

/** Production authentication backed by Cloudflare Access JWT signatures. */
export const accessAuthenticationLive = (
  options: AccessAuthenticationOptions
) => {
  const jwks = createRemoteJWKSet(
    new URL(`${options.teamDomain}/cdn-cgi/access/certs`)
  );
  return Layer.succeed(AccessAuthentication, {
    authenticate: (headers) => {
      const token = headers.get("cf-access-jwt-assertion");
      if (token === null) {
        return Effect.fail(new AuthenticationError({ reason: "missing" }));
      }
      return Effect.tryPromise({
        catch: () => new AuthenticationError({ reason: "invalid" }),
        try: async () => {
          const verified = await jwtVerify(token, jwks, {
            audience: options.audience,
            issuer: options.teamDomain,
          });
          const subject = Schema.decodeUnknownSync(Schema.String)(
            verified.payload.sub ?? verified.payload.email
          );
          if (subject.length === 0) {
            throw new Error("Access token has no subject");
          }
          return {
            subject,
            type: verified.payload.email === undefined ? "service" : "user",
          } as const;
        },
      });
    },
  });
};
