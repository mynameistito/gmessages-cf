import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Cause, Effect } from "effect";
import type { Layer } from "effect/Layer";
import { z } from "zod";

import { GoogleMessagesError } from "../services/google-messages";
import type { GoogleMessages } from "../services/google-messages";
import {
  MAX_READ_LIMIT,
  MessagingService,
} from "../services/messaging-service";
import { decodeMessageCursor } from "../services/repositories";
import type { MessageRepository } from "../services/repositories";

const toolErrorText = <E>(error: E) => {
  if (error instanceof GoogleMessagesError) {
    return error.reason;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Google Messages request failed";
};

/** Create the small, structured MCP tool surface. */
export const createMcpServer = (
  services: Layer<
    GoogleMessages | MessageRepository,
    GoogleMessagesError,
    never
  >
) => {
  const server = new McpServer({ name: "gmessages-cf", version: "0.1.0" });
  const runTool = async <A, E>(
    effect: Effect.Effect<A, E, GoogleMessages | MessageRepository>
  ) => {
    const exit = await Effect.runPromiseExit(Effect.provide(effect, services));
    if (exit._tag === "Success") {
      return {
        content: [{ text: JSON.stringify(exit.value), type: "text" as const }],
      };
    }
    const error = Cause.squash(exit.cause);
    return {
      content: [
        {
          text: toolErrorText(error),
          type: "text" as const,
        },
      ],
      isError: true,
    };
  };
  server.registerTool(
    "messages.list_conversations",
    {
      description: "List synced Google Messages conversations.",
      inputSchema: {},
    },
    () => runTool(MessagingService.listConversations)
  );
  server.registerTool(
    "messages.get_conversation",
    {
      description: "Read messages in one conversation.",
      inputSchema: {
        conversationId: z.string().min(1),
        cursor: z
          .string()
          .min(1)
          .refine((value) => {
            try {
              decodeMessageCursor(value);
              return true;
            } catch {
              return false;
            }
          })
          .optional(),
        limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
      },
    },
    ({ conversationId, limit, cursor }) =>
      runTool(MessagingService.getConversation(conversationId, limit, cursor))
  );
  server.registerTool(
    "messages.search",
    {
      description: "Search locally synced message text.",
      inputSchema: {
        cursor: z
          .string()
          .min(1)
          .refine((value) => {
            try {
              decodeMessageCursor(value);
              return true;
            } catch {
              return false;
            }
          })
          .optional(),
        limit: z.number().int().min(1).max(MAX_READ_LIMIT).optional(),
        query: z.string().min(1),
      },
    },
    ({ query, limit, cursor }) =>
      runTool(MessagingService.search(query, limit, cursor))
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
    ({ conversationId, idempotencyKey, text }) =>
      runTool(MessagingService.send(conversationId, text, idempotencyKey))
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
