/**
 * Builds the key-free, read-only Solana Connection that onchain_token_safety
 * uses, from SOLANA_RPC_URL only, and classifies web3.js failures into typed
 * ElizaErrors. The RPC URL can embed an API key, so it never enters error
 * context, logs, data or text: every message passes through `redact` first,
 * and a wrapped cause carries only a redacted copy of the original message.
 *
 * There is no fallback endpoint and no SolanaService, Helius or cloud proxy
 * involvement. Retries on HTTP 429 are disabled so one call makes one request,
 * and a per-request deadline comes from a `fetchMiddleware` abort signal.
 */
import { ElizaError, type IAgentRuntime, isElizaError } from "@elizaos/core";
import {
  Connection,
  type FetchMiddleware,
  SolanaJSONRPCError,
} from "@solana/web3.js";
import type {
  RpcUnknown,
  TokenSafetyDegradableCode,
  TokenSafetyThrownCode,
} from "./types.js";

export const TOKEN_SAFETY_RPC_TIMEOUT_MS = 10_000;

export type TokenSafetyRpc = {
  connection: Connection;
  redact(text: string): string;
};

const REDACTED = "<SOLANA_RPC_URL>";
const SETTING = "SOLANA_RPC_URL";
const MIN_COMPONENT_SECRET_LENGTH = 8;
const CREDENTIAL_PARAM = /key|token|secret|auth|pass|sig|cred/i;

/**
 * A provider response that parsed but carries a value the read cannot use
 * (for example a fractional epoch). It is classified as MALFORMED_RESPONSE,
 * so an independent sub-read degrades instead of discarding the report.
 */
export class TokenSafetyMalformedResponseError extends Error {
  override name = "TokenSafetyMalformedResponseError";
}

/**
 * Copies an error's name and message through `redact` so a cause kept for
 * diagnostics cannot carry the endpoint (web3.js and Bun echo the raw URL).
 */
function redactedCause(
  cause: unknown,
  redact: (text: string) => string,
): Error | undefined {
  if (!(cause instanceof Error)) return undefined;
  const copy = new Error(redact(cause.message));
  copy.name = cause.name;
  return copy;
}

function urlInvalid(cause?: Error): ElizaError {
  return new ElizaError(
    "SOLANA_RPC_URL is not a valid http(s) URL; onchain_token_safety reads only from that endpoint.",
    {
      code: "TOKEN_SAFETY_RPC_URL_INVALID",
      ...(cause === undefined ? {} : { cause }),
      context: { setting: SETTING, method: "configuration" },
      severity: "fatal",
    },
  );
}

/** Creates the token_safety Connection from SOLANA_RPC_URL, or throws a typed configuration error. */
export function createTokenSafetyRpc(
  runtime: Pick<IAgentRuntime, "getSetting">,
  timeoutMs = TOKEN_SAFETY_RPC_TIMEOUT_MS,
): TokenSafetyRpc {
  const setting = runtime.getSetting(SETTING);
  const trimmed = typeof setting === "string" ? setting.trim() : "";
  if (trimmed === "") {
    throw new ElizaError(
      "SOLANA_RPC_URL is not configured; onchain_token_safety reads only from that endpoint.",
      {
        code: "TOKEN_SAFETY_RPC_NOT_CONFIGURED",
        context: { setting: SETTING, method: "configuration" },
        severity: "fatal",
      },
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (cause) {
    // error-policy:J2 A malformed SOLANA_RPC_URL becomes a typed configuration error with a redacted copy of the cause; the value may embed a key, so it stays out of context and messages.
    throw urlInvalid(
      redactedCause(cause, (text) => text.split(trimmed).join(REDACTED)),
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw urlInvalid();
  }

  const query = url.search.startsWith("?") ? url.search.slice(1) : "";
  const userinfo = url.password
    ? `${url.username}:${url.password}`
    : url.username;
  // The password and the value of any credential-named query parameter
  // (api-key, token, auth, …) are credentials whatever their length, so they
  // are redacted both raw and percent-decoded.
  const credentials = [url.password];
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    for (const [name, value] of new URLSearchParams(pair)) {
      if (CREDENTIAL_PARAM.test(name))
        credentials.push(pair.slice(eq + 1), value);
    }
  }
  // A provider may echo only one piece of the URL (the bare API key from the
  // query, a path-embedded token, a key-bearing subdomain), so each component
  // is redacted on its own as well. Other components shorter than the minimum
  // are not credentials, and replacing them would rewrite ordinary digits and
  // words inside provider messages.
  const components = [
    ...url.pathname.split("/"),
    ...query.split("&").map((pair) => pair.slice(pair.indexOf("=") + 1)),
    ...url.searchParams.values(),
    url.username,
    url.password,
    userinfo,
    url.host,
    url.hostname,
    url.hash.startsWith("#") ? url.hash.slice(1) : "",
  ].filter((value) => value.length >= MIN_COMPONENT_SECRET_LENGTH);
  const secrets = [
    ...new Set([
      trimmed,
      url.href,
      `${url.origin}${url.pathname}`,
      url.origin,
      url.search,
      query,
      ...components,
      ...credentials,
    ]),
  ]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length);
  const redact = (text: string): string => {
    let out = text;
    for (const secret of secrets) {
      out = out.split(secret).join(REDACTED);
    }
    return out;
  };

  const fetchMiddleware: FetchMiddleware = (info, init, next) =>
    next(info, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  // web3.js validates the endpoint with its own case-sensitive pattern, which
  // rejects WHATWG-valid spellings (`https:/host`, `https:host`, `HTTPS://`)
  // and empty-username userinfo; the serialized `url.href` satisfies it
  // wherever a request is possible.
  let connection: Connection;
  try {
    connection = new Connection(url.href, {
      commitment: "confirmed",
      disableRetryOnRateLimit: true,
      fetchMiddleware,
    });
  } catch (cause) {
    // error-policy:J2 web3.js rejects the endpoint with a message that embeds it; the typed static-message URL_INVALID keeps only a redacted copy of that cause.
    throw urlInvalid(redactedCause(cause, redact));
  }
  return { connection, redact };
}

type Classified = {
  code: TokenSafetyThrownCode;
  rpcErrorCode: number | null;
  httpStatus: number | null;
};

/**
 * Socket-level error codes: errno names (ECONNREFUSED, ENOTFOUND, …), undici
 * socket codes (UND_ERR_SOCKET, …) and Bun's names (ConnectionRefused, …).
 * Node's internal ERR_* codes mark API misuse, not the network, so they are
 * excluded.
 */
const TRANSPORT_CODE =
  /^(?:E(?!RR_)[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|[A-Z][A-Za-z]+)$/;

function hasTransportCode(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return false;
  }
  return typeof value.code === "string" && TRANSPORT_CODE.test(value.code);
}

function classifyRpcFailure(cause: Error): Classified {
  if (cause.name === "TimeoutError" || cause.name === "AbortError") {
    return {
      code: "TOKEN_SAFETY_RPC_TIMEOUT",
      rpcErrorCode: null,
      httpStatus: null,
    };
  }
  if (cause instanceof SolanaJSONRPCError) {
    return {
      code: "TOKEN_SAFETY_RPC_REJECTED",
      rpcErrorCode: typeof cause.code === "number" ? cause.code : null,
      httpStatus: null,
    };
  }
  if (/^429 /.test(cause.message)) {
    return {
      code: "TOKEN_SAFETY_RPC_RATE_LIMITED",
      rpcErrorCode: null,
      httpStatus: 429,
    };
  }
  const http = /^(\d{3}) /.exec(cause.message);
  if (http) {
    return {
      code: "TOKEN_SAFETY_RPC_HTTP_ERROR",
      rpcErrorCode: null,
      httpStatus: Number(http[1]),
    };
  }
  // Only a network-level failure is a transport failure: Node's fetch rejects
  // with TypeError("fetch failed") or a TypeError whose cause carries a socket
  // code, and Bun's fetch error carries the code itself. Any other TypeError is
  // a bug in the read and must reach the action boundary, not degrade a check.
  if (
    hasTransportCode(cause) ||
    (cause.name === "TypeError" &&
      (cause.message === "fetch failed" || hasTransportCode(cause.cause)))
  ) {
    return {
      code: "TOKEN_SAFETY_RPC_TRANSPORT_FAILED",
      rpcErrorCode: null,
      httpStatus: null,
    };
  }
  // A body that is not the expected shape (StructError), a value the read
  // cannot use, or a 200 body that is not JSON at all (an HTML or text page
  // from a CDN or WAF, which JSON.parse rejects with a SyntaxError naming
  // JSON) is a provider failure shape. Any other SyntaxError is a bug.
  if (
    cause.name === "StructError" ||
    cause instanceof TokenSafetyMalformedResponseError ||
    (cause.name === "SyntaxError" && /\bJSON\b/.test(cause.message))
  ) {
    return {
      code: "TOKEN_SAFETY_RPC_MALFORMED_RESPONSE",
      rpcErrorCode: null,
      httpStatus: null,
    };
  }
  return {
    code: "TOKEN_SAFETY_RPC_FAILED",
    rpcErrorCode: null,
    httpStatus: null,
  };
}

/** Runs one web3.js read and rethrows any Error as a typed, redacted TOKEN_SAFETY_RPC_* ElizaError. */
export async function readRpc<T>(
  method: "getAccountInfo" | "getTokenLargestAccounts" | "getEpochInfo",
  mint: string,
  rpc: TokenSafetyRpc,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    // error-policy:J2 Classify the web3.js failure into a typed TOKEN_SAFETY_RPC_* error that keeps the cause; context carries method/mint only, never the URL.
    if (!(cause instanceof Error)) throw cause;
    const { code, rpcErrorCode, httpStatus } = classifyRpcFailure(cause);
    throw new ElizaError(
      rpc.redact(`Solana RPC ${method} failed: ${cause.message}`),
      {
        code,
        cause,
        context: { mint, method, rpcErrorCode, httpStatus },
        severity: "ephemeral",
      },
    );
  }
}

const DEGRADABLE: ReadonlySet<TokenSafetyDegradableCode> = new Set([
  "TOKEN_SAFETY_RPC_TIMEOUT",
  "TOKEN_SAFETY_RPC_RATE_LIMITED",
  "TOKEN_SAFETY_RPC_HTTP_ERROR",
  "TOKEN_SAFETY_RPC_REJECTED",
  "TOKEN_SAFETY_RPC_TRANSPORT_FAILED",
  "TOKEN_SAFETY_RPC_MALFORMED_RESPONSE",
]);

function isDegradableCode(code: string): code is TokenSafetyDegradableCode {
  return (DEGRADABLE as ReadonlySet<string>).has(code);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * Runs an independent sub-read after the mint read succeeded. Only the six
 * expected transport/JSON-RPC codes become a visible `RpcUnknown`; anything
 * else (including the unclassified TOKEN_SAFETY_RPC_FAILED) propagates.
 */
export async function degradeRpc<T>(
  runtime: Pick<IAgentRuntime, "logger">,
  method: "getTokenLargestAccounts" | "getEpochInfo",
  mint: string,
  rpc: TokenSafetyRpc,
  call: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; unknown: RpcUnknown }> {
  try {
    return { ok: true, value: await readRpc(method, mint, rpc, call) };
  } catch (e) {
    // error-policy:J4 The mint read already succeeded; an expected transport/JSON-RPC failure on an independent sub-read becomes a visibly unknown check with its typed code and the complete redacted reason, never 0%, an empty list or an omission.
    if (!(isElizaError(e) && isDegradableCode(e.code))) throw e;
    const code = e.code;
    runtime.logger.warn(
      { src: "wallet:token-safety", mint, method, code },
      "[TokenSafety] sub-read unavailable; reporting the check as unknown",
    );
    return {
      ok: false,
      unknown: {
        status: "unknown",
        code,
        reason: e.message,
        method,
        rpcErrorCode: numberOrNull(e.context?.rpcErrorCode),
        httpStatus: numberOrNull(e.context?.httpStatus),
      },
    };
  }
}
