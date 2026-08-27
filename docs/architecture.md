# Architecture

The application has an imperative shell (Worker, Container, D1/R2 adapters) around an Effect functional core. Domain schemas and application services do not import Cloudflare globals.

The primary session is coordinated by one Durable Object instance named `primary`. It serializes pairing, reconnect, and outbound operations. Container storage is disposable. The real adapter must serialize `libgm.AuthData`, encrypt the envelope with an application key held as a Cloudflare secret, and store ciphertext outside the Container before claiming restart recovery is complete.

The implementation uses localhost HTTP IPC because it is portable across Docker Desktop and Cloudflare Containers, observable during development, and supports request/response plus authenticated SSE events. Unix sockets are not assumed to exist in every target runtime. The IPC schema is Effect Schema validated at the TypeScript boundary.

The Go boundary is intentional. `pkg/libgm` contains the upstream protocol implementation, protobuf models, request cryptography, device lifecycle, and long-poll behavior. Reimplementing it in TypeScript would create a second protocol implementation and would not reduce the upstream licensing or review obligations. TypeScript owns the application contract and validates the normalized IPC projection; Go owns the upstream protocol process.

Cloudflare Queues are deliberately not used in the fake slice. They should be added only if event ingestion or outbox processing needs durable at-least-once delivery beyond the Durable Object and D1 transaction.
