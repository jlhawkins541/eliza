/**
 * Checks that every plugin the Crypto Queen character loads is configured on
 * this machine: the character file, local Ollama inference through
 * `@elizaos/plugin-zerollama`, Solana access through `@elizaos/plugin-wallet`,
 * and storage through `@elizaos/plugin-sql`. It reads only the given
 * environment and makes read-only calls (Ollama's model list and Solana
 * `getHealth` / `getBalance`); it never prints a key. `check-setup.ts` is the
 * command-line entry.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export type SetupCheckStatus = "pass" | "warn" | "fail";

export type SetupCheckArea =
  | "character"
  | "@elizaos/plugin-zerollama"
  | "@elizaos/plugin-wallet"
  | "@elizaos/plugin-sql";

export interface SetupCheck {
  area: SetupCheckArea;
  name: string;
  status: SetupCheckStatus;
  detail: string;
}

export type SetupEnv = Readonly<Record<string, string | undefined>>;

export interface SetupCheckDeps {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** File text, or null when the path cannot be read. */
  readFile: (path: string) => string | null;
}

const REQUEST_TIMEOUT_MS = 5_000;
const OLLAMA_MODEL_SETTINGS = [
  "OLLAMA_SMALL_MODEL",
  "OLLAMA_LARGE_MODEL",
  "OLLAMA_EMBEDDING_MODEL",
] as const;
const OTHER_MODEL_PROVIDER_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
] as const;
const LAMPORTS_PER_SOL = 1_000_000_000;

function setting(env: SetupEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkCharacter(env: SetupEnv, deps: SetupCheckDeps): SetupCheck {
  const area = "character";
  const name = "Character file";
  const characterPath = setting(env, "ELIZA_CHARACTER_PATH");
  if (!characterPath) {
    return {
      area,
      name,
      status: "fail",
      detail:
        "ELIZA_CHARACTER_PATH is not set, so the agent starts with its default character instead of Crypto Queen.",
    };
  }
  const text = deps.readFile(characterPath);
  if (text === null) {
    return {
      area,
      name,
      status: "fail",
      detail: `ELIZA_CHARACTER_PATH points at ${characterPath}, which can't be read.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // error-policy:J3 an unparseable character file is reported as a failed check.
    return {
      area,
      name,
      status: "fail",
      detail: `${characterPath} is not valid JSON: ${describeFailure(error)}`,
    };
  }
  const characterName =
    typeof parsed === "object" &&
    parsed !== null &&
    "name" in parsed &&
    typeof parsed.name === "string"
      ? parsed.name
      : null;
  if (!characterName) {
    return {
      area,
      name,
      status: "fail",
      detail: `${characterPath} has no character name.`,
    };
  }
  return {
    area,
    name,
    status: "pass",
    detail: `Loads ${characterName} from ${characterPath}.`,
  };
}

/** Ollama model names as `ollama list` shows them; `llama3.1` matches `llama3.1:latest`. */
function hasModel(installed: readonly string[], model: string): boolean {
  return installed.some((name) => name === model || name === `${model}:latest`);
}

async function checkOllama(
  env: SetupEnv,
  deps: SetupCheckDeps,
): Promise<SetupCheck[]> {
  const area = "@elizaos/plugin-zerollama";
  const baseUrl =
    setting(env, "OLLAMA_BASE_URL") ?? setting(env, "OLLAMA_API_ENDPOINT");
  const checks: SetupCheck[] = [];

  const unsetModels = OLLAMA_MODEL_SETTINGS.filter((key) => !setting(env, key));
  if (unsetModels.length > 0) {
    checks.push({
      area,
      name: "Model settings",
      status: "fail",
      detail: `${unsetModels.join(", ")} not set. Unset tiers ask for eliza-1 models, which stock Ollama does not have.`,
    });
  }

  if (!baseUrl) {
    checks.push({
      area,
      name: "Ollama server",
      status: "fail",
      detail:
        "OLLAMA_BASE_URL is not set. Point it at your Ollama server, for example http://localhost:11434.",
    });
    return checks;
  }

  let installed: string[];
  try {
    const response = await deps.fetch(
      `${baseUrl.replace(/\/+$/, "")}/api/tags`,
      { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body: unknown = await response.json();
    const models =
      typeof body === "object" &&
      body !== null &&
      "models" in body &&
      Array.isArray(body.models)
        ? body.models
        : null;
    if (!models) {
      throw new Error("the reply has no model list");
    }
    installed = models.flatMap((model: unknown) =>
      typeof model === "object" &&
      model !== null &&
      "name" in model &&
      typeof model.name === "string"
        ? [model.name]
        : [],
    );
  } catch (error) {
    // error-policy:J4 an unreachable Ollama server becomes a failed check the person can act on.
    checks.push({
      area,
      name: "Ollama server",
      status: "fail",
      detail: `Ollama is not answering at ${baseUrl} (${describeFailure(error)}). Start it with the desktop app or \`ollama serve\`.`,
    });
    return checks;
  }

  checks.push({
    area,
    name: "Ollama server",
    status: "pass",
    detail: `Answering at ${baseUrl} with ${installed.length} model${installed.length === 1 ? "" : "s"} pulled.`,
  });
  for (const key of OLLAMA_MODEL_SETTINGS) {
    const model = setting(env, key);
    if (!model) continue;
    checks.push(
      hasModel(installed, model)
        ? { area, name: key, status: "pass", detail: `${model} is pulled.` }
        : {
            area,
            name: key,
            status: "fail",
            detail: `${model} is not pulled. Run \`ollama pull ${model}\`.`,
          },
    );
  }

  const otherProviders = OTHER_MODEL_PROVIDER_KEYS.filter((key) =>
    setting(env, key),
  );
  if (otherProviders.length > 0) {
    checks.push({
      area,
      name: "Other model providers",
      status: "warn",
      detail: `${otherProviders.join(", ")} set. A cloud model may answer instead of Ollama; remove them to keep inference local.`,
    });
  }
  return checks;
}

async function solanaRpc(
  deps: SetupCheckDeps,
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await deps.fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("the reply is not JSON-RPC");
  }
  if ("error" in body && body.error) {
    const message =
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
        ? body.error.message
        : "unknown RPC error";
    throw new Error(message);
  }
  if (!("result" in body)) {
    throw new Error("the reply has no result");
  }
  return body.result;
}

function walletAddress(secret: string): string {
  const bytes = bs58.decode(secret);
  if (bytes.length !== 64) {
    throw new Error(`it decodes to ${bytes.length} bytes, not 64`);
  }
  return Keypair.fromSecretKey(bytes).publicKey.toBase58();
}

async function checkSolana(
  env: SetupEnv,
  deps: SetupCheckDeps,
): Promise<SetupCheck[]> {
  const area = "@elizaos/plugin-wallet";
  const checks: SetupCheck[] = [];
  const rpcUrl = setting(env, "SOLANA_RPC_URL");
  let rpcHealthy = false;

  if (!rpcUrl) {
    checks.push({
      area,
      name: "Solana RPC",
      status: "fail",
      detail:
        "SOLANA_RPC_URL is not set, so the wallet skips Solana: balances, token_info and Real trade won't work.",
    });
  } else {
    try {
      const health = await solanaRpc(deps, rpcUrl, "getHealth", []);
      if (health !== "ok") {
        throw new Error(`getHealth returned ${JSON.stringify(health)}`);
      }
      rpcHealthy = true;
      checks.push({
        area,
        name: "Solana RPC",
        status: "pass",
        detail: "The RPC answers getHealth with ok.",
      });
    } catch (error) {
      // error-policy:J4 an unreachable RPC becomes a failed check the person can act on.
      checks.push({
        area,
        name: "Solana RPC",
        status: "fail",
        detail: `SOLANA_RPC_URL did not answer (${describeFailure(error)}).`,
      });
    }
  }

  const secret = setting(env, "SOLANA_PRIVATE_KEY");
  if (!secret) {
    checks.push({
      area,
      name: "Solana wallet key",
      status: "warn",
      detail:
        "SOLANA_PRIVATE_KEY is not set. Read-only checks work; Real trade can't sign.",
    });
  } else {
    let address: string | null = null;
    try {
      address = walletAddress(secret);
    } catch (error) {
      // error-policy:J3 a malformed key is reported without echoing any of it.
      checks.push({
        area,
        name: "Solana wallet key",
        status: "fail",
        detail: `SOLANA_PRIVATE_KEY is not a base58 Solana secret key: ${describeFailure(error)}.`,
      });
    }
    if (address && rpcUrl && rpcHealthy) {
      try {
        const balance = await solanaRpc(deps, rpcUrl, "getBalance", [address]);
        const lamports =
          typeof balance === "object" &&
          balance !== null &&
          "value" in balance &&
          typeof balance.value === "number"
            ? balance.value
            : null;
        if (lamports === null) {
          throw new Error("getBalance returned no value");
        }
        checks.push({
          area,
          name: "Solana wallet key",
          status: "pass",
          detail: `Wallet ${address} holds ${lamports / LAMPORTS_PER_SOL} SOL. Keep only trading funds in this hot wallet.`,
        });
      } catch (error) {
        // error-policy:J4 a failed balance read is shown as a warning; the key itself is valid.
        checks.push({
          area,
          name: "Solana wallet key",
          status: "warn",
          detail: `Wallet ${address} is valid, but its balance could not be read (${describeFailure(error)}).`,
        });
      }
    } else if (address) {
      checks.push({
        area,
        name: "Solana wallet key",
        status: "pass",
        detail: `Wallet ${address} is valid. Its balance needs a working SOLANA_RPC_URL.`,
      });
    }
  }

  const maxBuy = setting(env, "WALLET_TERMINAL_MAX_BUY_SOL");
  if (maxBuy !== null) {
    const value = Number(maxBuy);
    checks.push(
      Number.isFinite(value) && value > 0
        ? {
            area,
            name: "Real trade buy cap",
            status: "pass",
            detail: `Terminal buys are capped at ${value} SOL.`,
          }
        : {
            area,
            name: "Real trade buy cap",
            status: "fail",
            detail:
              "WALLET_TERMINAL_MAX_BUY_SOL must be a positive number of SOL.",
          },
    );
  }
  return checks;
}

function checkStorage(env: SetupEnv): SetupCheck {
  const area = "@elizaos/plugin-sql";
  if (setting(env, "POSTGRES_URL")) {
    return {
      area,
      name: "Database",
      status: "pass",
      detail: "Uses the Postgres server in POSTGRES_URL.",
    };
  }
  const dataDir = setting(env, "PGLITE_DATA_DIR") ?? ".eliza/.elizadb";
  return {
    area,
    name: "Database",
    status: "pass",
    detail: `Uses embedded PGlite at ${dataDir}; nothing to install.`,
  };
}

/** Runs every check in a fixed order; network checks run one after another. */
export async function checkCryptoQueenSetup(
  env: SetupEnv,
  deps: SetupCheckDeps,
): Promise<SetupCheck[]> {
  return [
    checkCharacter(env, deps),
    ...(await checkOllama(env, deps)),
    ...(await checkSolana(env, deps)),
    checkStorage(env),
  ];
}

/**
 * Parses `KEY=VALUE` lines the way a dotenv file holds them: blank lines and
 * `#` comments skipped, one pair of matching outer quotes removed.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || rawValue === undefined) continue;
    const quoted = /^(["'])(.*)\1$/.exec(rawValue);
    values[key] = quoted?.[2] ?? rawValue;
  }
  return values;
}
