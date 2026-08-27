import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Effect } from "effect";
import type { Layer } from "effect/Layer";
import { z } from "zod";

import type {
  GoogleMessages,
  GoogleMessagesError,
} from "../services/google-messages";
import { MessagingService } from "../services/messaging-service";
import type { MessageRepository } from "../services/repositories";

/** Create the small, structured MCP tool surface. */
export const createMcpServer = (
  services: Layer<
    GoogleMessages | MessageRepository,
    GoogleMessagesError,
    never
  >
) => {
  const server = new McpServer({ name: "gmessages-cf", version: "0.1.0" });
  const run = <A, E>(
    effect: Effect.Effect<A, E, GoogleMessages | MessageRepository>
  ) => Effect.runPromise(Effect.provide(effect, services));
  server.registerTool(
    "messages.list_conversations",
    {
      description: "List synced Google Messages conversations.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          text: JSON.stringify(await run(MessagingService.listConversations)),
          type: "text",
        },
      ],
    })
  );
  server.registerTool(
    "messages.get_conversation",
    {
      description: "Read messages in one conversation.",
      inputSchema: { conversationId: z.string().min(1) },
    },
    async ({ conversationId }) => ({
      content: [
        {
          text: JSON.stringify(
            await run(MessagingService.getConversation(conversationId))
          ),
          type: "text",
        },
      ],
    })
  );
  server.registerTool(
    "messages.search",
    {
      description: "Search locally synced message text.",
      inputSchema: { query: z.string().min(1) },
    },
    async ({ query }) => ({
      content: [
        {
          text: JSON.stringify(await run(MessagingService.search(query))),
          type: "text",
        },
      ],
    })
  );
  server.registerTool(
    "messages.send",
    {
      description:
        "Send one personal message. Always provide a stable idempotency key at the caller layer.",
      inputSchema: {
        conversationId: z.string().min(1),
        idempotencyKey: z.string().min(1),
        text: z.string().min(1).max(4000),
      },
    },
    async ({ conversationId, idempotencyKey, text }) => ({
      content: [
        {
          text: JSON.stringify(
            await run(
              MessagingService.send(conversationId, text, idempotencyKey)
            )
          ),
          type: "text",
        },
      ],
    })
  );
  return server;
};

/** Handle one MCP Streamable HTTP request in a Cloudflare-compatible runtime. */
export const handleMcpRequest = async (
  request: Request,
  services: Layer<
    GoogleMessages | MessageRepository,
    GoogleMessagesError,
    never
  >
): Promise<Response> => {
  const transport = new WebStandardStreamableHTTPServerTransport({});
  const server = createMcpServer(services);
  await server.connect(transport);
  return transport.handleRequest(request);
};
