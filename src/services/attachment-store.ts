import type { R2Object } from "@cloudflare/workers-types";
import { Context } from "effect";
import type { Effect } from "effect";

import type { StorageError } from "./storage-error";

/** Private attachment storage capability. */
export interface AttachmentStoreService {
  readonly get: (key: string) => Effect.Effect<R2Object | null, StorageError>;
  readonly put: (
    key: string,
    value: ArrayBuffer | string
  ) => Effect.Effect<void, StorageError>;
}

/** R2 attachment service tag. */
export class AttachmentStore extends Context.Service<
  AttachmentStore,
  AttachmentStoreService
>()("gmessages/AttachmentStore") {}
