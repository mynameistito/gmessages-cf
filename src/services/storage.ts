import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { Effect, Layer } from "effect";

import { AttachmentStore } from "./attachment-store";
import { D1 } from "./d1-service";
import type { D1Statement } from "./d1-service";
import { StorageError } from "./storage-error";

/** Build a D1 service around a native Worker binding. */
export const d1Live = (database: D1Database) =>
  Layer.succeed(D1, {
    all: <Row>(query: string, ...parameters: readonly unknown[]) =>
      Effect.tryPromise({
        catch: (cause) => new StorageError({ cause, operation: "d1.all" }),
        try: async () => {
          const result = await database
            .prepare(query)
            .bind(...parameters)
            .all<Row>();
          return result.results;
        },
      }),
    batch: (statements: readonly D1Statement[]) =>
      Effect.tryPromise({
        catch: (cause) => new StorageError({ cause, operation: "d1.batch" }),
        try: async () => {
          const results = await database.batch(
            statements.map((statement) =>
              database.prepare(statement.query).bind(...statement.parameters)
            )
          );
          return results.map((result) => result.meta.changes);
        },
      }),
    first: <Row>(query: string, ...parameters: readonly unknown[]) =>
      Effect.tryPromise({
        catch: (cause) => new StorageError({ cause, operation: "d1.first" }),
        try: () =>
          database
            .prepare(query)
            .bind(...parameters)
            .first<Row>(),
      }),
    run: (query, ...parameters) =>
      Effect.tryPromise({
        catch: (cause) => new StorageError({ cause, operation: "d1.run" }),
        try: async () => {
          const result = await database
            .prepare(query)
            .bind(...parameters)
            .run();
          return result.meta.changes;
        },
      }),
  });

/** Build a private attachment store around a native R2 binding. */
export const attachmentStoreLive = (bucket: R2Bucket) =>
  Layer.succeed(AttachmentStore, {
    get: (key) =>
      Effect.tryPromise({
        catch: (cause) => new StorageError({ cause, operation: "r2.get" }),
        try: () => bucket.get(key),
      }),
    put: (key, value) =>
      Effect.tryPromise({
        catch: (cause) => new StorageError({ cause, operation: "r2.put" }),
        try: async () => {
          await bucket.put(key, value);
        },
      }),
  });
