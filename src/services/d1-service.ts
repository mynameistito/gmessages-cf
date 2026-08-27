import { Context } from "effect";
import type { Effect } from "effect";

import type { StorageError } from "./storage-error";

export interface D1Statement {
  readonly query: string;
  readonly parameters: readonly unknown[];
}

/** Narrow SQL capability used by persistence adapters. */
export interface D1Service {
  readonly all: <Row>(
    query: string,
    ...parameters: readonly unknown[]
  ) => Effect.Effect<readonly Row[], StorageError>;
  readonly first: <Row>(
    query: string,
    ...parameters: readonly unknown[]
  ) => Effect.Effect<Row | null, StorageError>;
  readonly run: (
    query: string,
    ...parameters: readonly unknown[]
  ) => Effect.Effect<number, StorageError>;
  readonly batch: (
    statements: readonly D1Statement[]
  ) => Effect.Effect<readonly number[], StorageError>;
}

/** D1 service tag. */
export class D1 extends Context.Service<D1, D1Service>()("gmessages/D1") {}
