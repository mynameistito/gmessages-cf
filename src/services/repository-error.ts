import { Data } from "effect";

/** Persistence failure. */
export class RepositoryError extends Data.TaggedError("RepositoryError")<{
  readonly cause: string;
  readonly operation: string;
}> {}
