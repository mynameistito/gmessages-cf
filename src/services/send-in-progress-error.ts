import { Data } from "effect";

/** Indicates that another delivery currently owns the idempotency key. */
export class SendInProgressError extends Data.TaggedError(
  "SendInProgressError"
)<{
  readonly idempotencyKey: string;
}> {}
