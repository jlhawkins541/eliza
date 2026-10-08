/**
 * Checks that every plugin the Crypto Queen character loads is configured on
 * this machine: the character file, local Ollama inference through
 * `@elizaos/plugin-zerollama`, Solana access through `@elizaos/plugin-wallet`,
 * and storage through `@elizaos/plugin-sql`. It reads only the given
 * environment and verifies every connection with read-only calls: Ollama's
 * model list, Solana `getHealth` / `getBalance`, the CoinGecko and CoinPaprika
 * market feeds, DexScreener and GoPlus for token checks, each Jito block
 * engine's tip accounts, a Kraken or OKX balance read when its keys are set,
 * and one LunarCrush lookup when a key is set. It never places an order and
 * never prints a key. `check-setup.ts` is the command-line entry.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { DEXSCREENER_TOKEN_PAIRS_URL } from "../analytics/dexscreener/pairs.js";
import { GOPLUS_SOLANA_URL } from "../analytics/goplus/solana-token-security.js";
import {
  fetchLunarCrushSocialSignal,
  LunarCrushError,
} from "../analytics/lunarcrush/social-signal.js";
import {
  EXCHANGE_VENUE_SETTINGS,
  ExchangeVenueError,
  exchangeClient,
  type VenueRuntime,
} from "../api/exchange-venues.js";
import { resolveJitoRoute } from "../api/terminal-trade.js";
import type { WalletExchangeVenue } from "../contracts.js";
import { COINPAPRIKA_API_BASE } from "../routes/coinpaprika-backup.js";
import { COINGECKO_API_BASE } from "../routes/wallet-terminal-market-route.js";

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

  // Same bounds terminal-trade.ts enforces: Jito's minimum tip up to the RPC
  // route's priority-fee cap.
  const jitoTip = setting(env, "WALLET_TERMINAL_JITO_TIP_LAMPORTS");
  if (jitoTip !== null) {
    const value = Number(jitoTip);
    checks.push(
      Number.isSafeInteger(value) && value >= 1_000 && value <= 4_000_000
        ? {
            area,
            name: "Jito tip",
            status: "pass",
            detail: `Trades sent through Jito tip ${value / 1_000_000_000} SOL.`,
          }
        : {
            area,
            name: "Jito tip",
            status: "fail",
            detail:
              "WALLET_TERMINAL_JITO_TIP_LAMPORTS must be a whole number from 1000 to 4000000.",
          },
    );
  }
  return checks;
}

/** Wrapped SOL: a mint every Solana data provider knows. */
const PROBE_MINT = "So11111111111111111111111111111111111111112";

type Probe = { ok: true } | { ok: false; reason: string };

/**
 * One read-only request; `accepts` decides whether the JSON answer is the
 * provider's real reply rather than an error page or a stub.
 */
async function probe(
  deps: SetupCheckDeps,
  url: string,
  accepts: (body: unknown) => boolean,
  init: RequestInit = {},
): Promise<Probe> {
  try {
    const response = await deps.fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const body: unknown = await response.json();
    return accepts(body)
      ? { ok: true }
      : { ok: false, reason: "the reply is not what it should be" };
  } catch (error) {
    // error-policy:J4 an unreachable provider becomes a check line the person can act on.
    return { ok: false, reason: describeFailure(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Markets read CoinGecko first and fall back to CoinPaprika. */
async function checkMarketData(deps: SetupCheckDeps): Promise<SetupCheck> {
  const area = "@elizaos/plugin-wallet";
  const name = "Market prices";
  const [primary, backup] = await Promise.all([
    probe(
      deps,
      `${COINGECKO_API_BASE}/ping`,
      (body) => isRecord(body) && typeof body.gecko_says === "string",
    ),
    probe(
      deps,
      `${COINPAPRIKA_API_BASE}/global`,
      (body) => isRecord(body) && typeof body.market_cap_usd === "number",
    ),
  ]);
  if (primary.ok && backup.ok) {
    return {
      area,
      name,
      status: "pass",
      detail: "CoinGecko answers, and the CoinPaprika backup answers too.",
    };
  }
  if (primary.ok && !backup.ok) {
    return {
      area,
      name,
      status: "warn",
      detail: `CoinGecko answers, but the CoinPaprika backup did not (${backup.reason}).`,
    };
  }
  if (!primary.ok && backup.ok) {
    return {
      area,
      name,
      status: "warn",
      detail: `CoinGecko did not answer (${primary.reason}); Markets will use the CoinPaprika backup.`,
    };
  }
  return {
    area,
    name,
    status: "fail",
    detail: `Neither CoinGecko (${primary.ok ? "" : primary.reason}) nor CoinPaprika (${backup.ok ? "" : backup.reason}) answered, so Markets and charts are empty.`,
  };
}

/** Token checks before a trade: GoPlus safety and DexScreener liquidity. */
async function checkTokenData(deps: SetupCheckDeps): Promise<SetupCheck[]> {
  const area = "@elizaos/plugin-wallet";
  const goplusUrl = new URL(GOPLUS_SOLANA_URL);
  goplusUrl.searchParams.set("contract_addresses", PROBE_MINT);
  const [goplus, dexscreener] = await Promise.all([
    probe(
      deps,
      goplusUrl.toString(),
      (body) => isRecord(body) && body.code === 1,
    ),
    probe(deps, `${DEXSCREENER_TOKEN_PAIRS_URL}/${PROBE_MINT}`, (body) =>
      Array.isArray(body),
    ),
  ]);
  return [
    goplus.ok
      ? {
          area,
          name: "GoPlus token safety",
          status: "pass",
          detail: "GoPlus answers token_safety lookups.",
        }
      : {
          area,
          name: "GoPlus token safety",
          status: "fail",
          detail: `GoPlus did not answer (${goplus.reason}), so token_safety can't check a mint before a trade.`,
        },
    dexscreener.ok
      ? {
          area,
          name: "DexScreener liquidity",
          status: "pass",
          detail: "DexScreener answers token_pairs lookups.",
        }
      : {
          area,
          name: "DexScreener liquidity",
          status: "fail",
          detail: `DexScreener did not answer (${dexscreener.reason}), so token_pairs can't show liquidity or pool age.`,
        },
  ];
}

/**
 * Asks each Jito block engine, the reviewed one and its backup regions, for
 * its tip accounts: a read-only call every engine serves.
 */
async function checkJito(
  env: SetupEnv,
  deps: SetupCheckDeps,
): Promise<SetupCheck> {
  const area = "@elizaos/plugin-wallet";
  const name = "Jito block engines";
  let route: { blockEngineUrl: string; backupBlockEngineUrls: string[] };
  try {
    route = resolveJitoRoute({ getSetting: (key) => setting(env, key) });
  } catch (error) {
    // error-policy:J3 an unusable Jito setting is reported as a failed check.
    return { area, name, status: "fail", detail: describeFailure(error) };
  }
  const engines = [route.blockEngineUrl, ...route.backupBlockEngineUrls];
  const results = await Promise.all(
    engines.map((url) =>
      probe(
        deps,
        `${url}/api/v1/getTipAccounts`,
        (body) => isRecord(body) && Array.isArray(body.result),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTipAccounts",
            params: [],
          }),
        },
      ),
    ),
  );
  const down = engines.flatMap((url, index) => {
    const result = results[index];
    return result && !result.ok
      ? [`${new URL(url).host} (${result.reason})`]
      : [];
  });
  const answering = engines.length - down.length;
  const downText = down.length > 0 ? ` Not answering: ${down.join(", ")}.` : "";
  if (results[0]?.ok) {
    return {
      area,
      name,
      status: "pass",
      detail: `${new URL(route.blockEngineUrl).host} answers, with ${answering - 1} of ${engines.length - 1} backup regions answering.${downText}`,
    };
  }
  return {
    area,
    name,
    status: "warn",
    detail:
      answering > 0
        ? `The first block engine is down; Jito sends will use a backup region.${downText}`
        : `No Jito block engine answered, so the Jito route will fail; the RPC route still works.${downText}`,
  };
}

const VENUE_NAMES: Record<WalletExchangeVenue, string> = {
  kraken: "Kraken",
  okx: "OKX",
};
/** A currency each venue reports a balance for, used only to prove the key works. */
const VENUE_PROBE_CURRENCY: Record<WalletExchangeVenue, string> = {
  kraken: "USD",
  okx: "USDT",
};

/**
 * Exchange orders are optional. With every key for a venue set, one balance
 * read shows whether the venue accepts the key; nothing is ordered.
 */
async function checkExchange(
  env: SetupEnv,
  deps: SetupCheckDeps,
  venue: WalletExchangeVenue,
): Promise<SetupCheck> {
  const area = "@elizaos/plugin-wallet";
  const venueName = VENUE_NAMES[venue];
  const name = `${venueName} orders`;
  const keys = EXCHANGE_VENUE_SETTINGS[venue];
  const missing = keys.filter((key) => setting(env, key) === null);
  if (missing.length === keys.length) {
    return {
      area,
      name,
      status: "warn",
      detail: `${keys.join(", ")} not set, so ${venueName} limit orders are off. Optional.`,
    };
  }
  if (missing.length > 0) {
    return {
      area,
      name,
      status: "fail",
      detail: `${missing.join(", ")} not set; ${venueName} needs all of ${keys.join(", ")}.`,
    };
  }
  const runtime: VenueRuntime = {
    getSetting: (key) => setting(env, key),
    fetch: (input, init) => deps.fetch(String(input), init),
  };
  try {
    await exchangeClient(runtime, venue).availableBalance(
      VENUE_PROBE_CURRENCY[venue],
    );
    return {
      area,
      name,
      status: "pass",
      detail: `${venueName} accepted the key on a read-only balance check.`,
    };
  } catch (error) {
    // error-policy:J1 setup-check boundary: the failure becomes a check line.
    const refused =
      error instanceof ExchangeVenueError && error.kind === "refused";
    return {
      area,
      name,
      status: refused ? "fail" : "warn",
      detail: refused
        ? `${venueName} refused the key (${describeFailure(error)}). Check that it can read balances and trade.`
        : describeFailure(error),
    };
  }
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

/**
 * The social signal is optional: no key is a warning. With a key, one BTC
 * lookup shows whether LunarCrush accepts it.
 */
async function checkSocialSignal(
  env: SetupEnv,
  deps: SetupCheckDeps,
): Promise<SetupCheck> {
  const area = "@elizaos/plugin-wallet";
  const name = "LunarCrush social signal";
  const apiKey = setting(env, "LUNARCRUSH_API_KEY");
  if (apiKey === null) {
    return {
      area,
      name,
      status: "warn",
      detail:
        'LUNARCRUSH_API_KEY is not set, so the Social row and social_signal show "Add a LunarCrush key". Optional.',
    };
  }
  try {
    const signal = await fetchLunarCrushSocialSignal(
      "BTC",
      apiKey,
      (input, init) =>
        deps.fetch(String(input), {
          ...init,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
    );
    return {
      area,
      name,
      status: "pass",
      detail:
        signal.status === "tracked"
          ? `LunarCrush accepted the key (BTC Galaxy Score ${signal.galaxyScore ?? "not reported"}).`
          : "LunarCrush accepted the key.",
    };
  } catch (error) {
    // error-policy:J1 setup-check boundary: the failure becomes a check line.
    const rejected =
      error instanceof LunarCrushError && error.kind === "key-rejected";
    return {
      area,
      name,
      status: rejected ? "fail" : "warn",
      detail: describeFailure(error),
    };
  }
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
    await checkMarketData(deps),
    ...(await checkTokenData(deps)),
    await checkJito(env, deps),
    await checkExchange(env, deps, "kraken"),
    await checkExchange(env, deps, "okx"),
    await checkSocialSignal(env, deps),
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
