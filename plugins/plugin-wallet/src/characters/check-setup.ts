/**
 * Command-line setup check for the Crypto Queen agent:
 * `bun run --cwd plugins/plugin-wallet check:crypto-queen`. It reads
 * `packages/agent/.env` (the file `bun run start` loads), lets the shell
 * environment override it the same way, resolves a relative character path
 * from `packages/agent` as the agent does, runs `checkCryptoQueenSetup`, prints
 * one line per check, and exits 1 when any check fails.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkCryptoQueenSetup,
  parseEnvFile,
  type SetupCheckStatus,
} from "./setup-check";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const agentDir = path.join(repoRoot, "packages/agent");
const agentEnvPath = path.join(agentDir, ".env");

const LABEL: Record<SetupCheckStatus, string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
};

function readText(filePath: string): string | null {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(agentDir, filePath);
  if (!existsSync(resolved)) return null;
  return readFileSync(resolved, "utf8");
}

const fileEnv = existsSync(agentEnvPath)
  ? parseEnvFile(readFileSync(agentEnvPath, "utf8"))
  : {};
const env = { ...fileEnv, ...process.env };

process.stdout.write(
  existsSync(agentEnvPath)
    ? `Reading ${agentEnvPath} and the shell environment.\n\n`
    : `No ${agentEnvPath}; reading the shell environment only.\n\n`,
);

const checks = await checkCryptoQueenSetup(env, {
  fetch: (input, init) => fetch(input, init),
  readFile: readText,
});

let area = "";
for (const check of checks) {
  if (check.area !== area) {
    area = check.area;
    process.stdout.write(`${area}\n`);
  }
  process.stdout.write(
    `  ${LABEL[check.status]}  ${check.name}: ${check.detail}\n`,
  );
}

const failed = checks.filter((check) => check.status === "fail").length;
const warned = checks.filter((check) => check.status === "warn").length;
process.stdout.write(
  `\n${failed === 0 ? "Ready" : "Not ready"}: ${failed} failed, ${warned} warning${warned === 1 ? "" : "s"}.\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
