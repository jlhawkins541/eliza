/**
 * MCP transport glue for the terminal's read-only tools: serves
 * {@link TERMINAL_MCP_TOOLS} through the SDK's low-level server over stdio for
 * clients such as Claude Desktop.
 *
 * `@modelcontextprotocol/sdk` is an optional dependency imported dynamically,
 * so the wallet plugin builds and loads without it; only someone running the
 * MCP server needs it installed. The catalog and dispatch in
 * `terminal-tools.ts` carry the logic and are tested against a real HTTP
 * server. A failed call returns an MCP error result with the reason, never an
 * empty success.
 */
import {
  dispatchTerminalMcpTool,
  TERMINAL_MCP_TOOLS,
  type TerminalMcpTarget,
  type TerminalMcpTool,
} from "./terminal-tools.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** The subset of the SDK's low-level `Server` used here, typed locally. */
interface McpServerLike {
  setRequestHandler(
    schema: unknown,
    handler: (request: {
      params: { name?: string; arguments?: Record<string, unknown> };
    }) => Promise<unknown>,
  ): void;
  connect(transport: unknown): Promise<void>;
}

interface McpSdk {
  Server: new (
    info: { name: string; version: string },
    options: { capabilities: { tools: Record<string, never> } },
  ) => McpServerLike;
  ListToolsRequestSchema: unknown;
  CallToolRequestSchema: unknown;
}

function toInputSchema(tool: TerminalMcpTool): Record<string, unknown> {
  return {
    type: "object",
    properties: tool.properties,
    ...(tool.required.length > 0 ? { required: tool.required } : {}),
  };
}

/** Run one tool call and shape it as an MCP result. */
export async function runTerminalMcpTool(
  target: TerminalMcpTarget,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const answer = await dispatchTerminalMcpTool(target, name, args);
    return { content: [{ type: "text", text: JSON.stringify(answer) }] };
  } catch (error) {
    // error-policy:J1 MCP boundary: the client receives a structured error result.
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

async function loadSdk(): Promise<McpSdk> {
  try {
    // Indirect specifiers so the type-checker and bundler don't require the
    // optional package at build time.
    const serverSpec = "@modelcontextprotocol/sdk/server/index.js";
    const typesSpec = "@modelcontextprotocol/sdk/types.js";
    const [serverModule, typesModule] = await Promise.all([
      import(serverSpec) as Promise<Pick<McpSdk, "Server">>,
      import(typesSpec) as Promise<
        Pick<McpSdk, "ListToolsRequestSchema" | "CallToolRequestSchema">
      >,
    ]);
    return {
      Server: serverModule.Server,
      ListToolsRequestSchema: typesModule.ListToolsRequestSchema,
      CallToolRequestSchema: typesModule.CallToolRequestSchema,
    };
  } catch (error) {
    // error-policy:J2 context-adding rethrow: say which package to install.
    throw new Error(
      `@modelcontextprotocol/sdk is required to run the terminal MCP server. Install it (it is an optional dependency): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Create the terminal MCP server. The tool list is served from the catalog's
 * JSON schemas through the SDK's low-level server, so no schema library is
 * needed. Throws if the optional SDK is missing.
 */
export async function createTerminalMcpServer(
  target: TerminalMcpTarget,
): Promise<McpServerLike> {
  const sdk = await loadSdk();
  const server = new sdk.Server(
    { name: "elizaos-terminal", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({
    tools: TERMINAL_MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toInputSchema(tool),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    })),
  }));
  server.setRequestHandler(sdk.CallToolRequestSchema, (request) =>
    runTerminalMcpTool(
      target,
      request.params.name ?? "",
      request.params.arguments ?? {},
    ),
  );
  return server;
}

/** Create the server and connect it over stdio. */
export async function connectTerminalMcpStdio(
  target: TerminalMcpTarget,
): Promise<McpServerLike> {
  const server = await createTerminalMcpServer(target);
  const stdioSpec = "@modelcontextprotocol/sdk/server/stdio.js";
  const { StdioServerTransport } = (await import(stdioSpec)) as {
    StdioServerTransport: new () => unknown;
  };
  await server.connect(new StdioServerTransport());
  return server;
}
