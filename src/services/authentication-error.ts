import { Data } from "effect";

/** Authentication failure at the inbound boundary. */
export class AuthenticationError extends Data.TaggedError(
  "AuthenticationError"
)<{
  readonly reason: "invalid" | "missing";
}> {}
