import { Data } from "effect";

/** Failure from a Cloudflare storage binding. */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly cause: unknown;
  readonly operation: string;
}> {}
