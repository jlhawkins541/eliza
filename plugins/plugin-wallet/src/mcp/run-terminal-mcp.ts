/**
 * Command-line entry for the terminal's read-only MCP server:
 * `bun run --cwd plugins/plugin-wallet mcp`, or the same command in an MCP
 * client's server config. It reads `packages/agent/.env` (the file
 * `bun run start` loads) under the shell environment, points the tools at that
 * agent, and serves them over stdio. Stdout carries only the MCP protocol, so
 * every message here goes to stderr; a start failure exits 1.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../characters/setup-check";
import { connectTerminalMcpStdio } from "./server";
import { resolveTerminalMcpTarget } from "./terminal-tools";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentEnvPath = path.resolve(here, "../../../../packages/agent/.env");

try {
  const fileEnv = existsSync(agentEnvPath)
    ? parseEnvFile(readFileSync(agentEnvPath, "utf8"))
    : {};
  const target = resolveTerminalMcpTarget(
    { ...fileEnv, ...process.env },
    (input, init) => fetch(input, init),
  );
  await connectTerminalMcpStdio(target);
  process.stderr.write(
    `elizaOS terminal MCP server is reading the agent at ${target.baseUrl}.\n`,
  );
} catch (error) {
  // error-policy:J1 process boundary: report why it could not start and exit 1.
  process.stderr.write(
    `The terminal MCP server could not start: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
}
