import { Data } from "effect";

/** Typed failure from the Google Messages adapter. */
export class GoogleMessagesError extends Data.TaggedError(
  "GoogleMessagesError"
)<{
  readonly reason: string;
  readonly retryable: boolean;
}> {}
