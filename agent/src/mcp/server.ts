import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ACTION_TOOLS, ACTION_TOOL_NAMES, type ActionToolDeps, callActionTool } from "./actions/tools.js";
import { READ_SESSION_MESSAGE, SessionError } from "./session.js";
import { AccessDeniedError, READ_TOOLS, ToolInputError, callReadTool } from "./tools.js";

/**
 * MCP server exposing the read tools, `open_read_session` and, when configured, the action tools.
 * A model connected to it gets no signing, spending or delegation authority: none of these
 * handlers can reach a signer. Action tools only build previews, bind a user's NEP-413 signature
 * (or a grant delegate) to one exact preview, and hand the unsigned transaction to the signer's
 * own wallet; model output is never accepted as authorization.
 */

export const OPEN_SESSION_TOOL = {
  name: "open_read_session",
  description:
    `Exchange a NEP-413 signature (message "${READ_SESSION_MESSAGE}") from a full-access key for a ` +
    "read session token used by account-scoped reads. Grants no signing or spending authority.",
  inputSchema: {
    type: "object" as const,
    properties: {
      accountId: { type: "string" },
      publicKey: { type: "string" },
      signature: { type: "string" },
      nonce: { type: "string", description: "Base64 of the 32-byte nonce that was signed." },
    },
    required: ["accountId", "publicKey", "signature", "nonce"],
    additionalProperties: false,
  },
};

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** Handles one tool call; exported so it can be tested without a transport. */
export async function handleMcpToolCall(name: string, args: Record<string, unknown>, deps: ActionToolDeps) {
  try {
    if (name === OPEN_SESSION_TOOL.name) {
      return text(await deps.sessions.open(args as never));
    }
    if (ACTION_TOOL_NAMES.includes(name)) return text(await callActionTool(name, args, deps));
    return text(await callReadTool(name, args, deps));
  } catch (err) {
    if (err instanceof ToolInputError || err instanceof AccessDeniedError || err instanceof SessionError) {
      return text(`refused: ${err.message}`, true);
    }
    return text("read source unavailable", true);
  }
}

export function buildMcpServer(deps: ActionToolDeps): Server {
  const server = new Server({ name: "valtrum-read", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...READ_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      OPEN_SESSION_TOOL,
      ...(deps.actions ? ACTION_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : []),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    handleMcpToolCall(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, deps),
  );
  return server;
}
