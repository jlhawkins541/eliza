/**
 * Pure resolution and classification of the HTTP endpoints that model
 * providers are reached at.
 *
 * The agent host and the Models page must agree with the provider plugins on
 * which endpoint is live. The Ollama precedence mirrors
 * `plugins/plugin-zerollama/utils/config.ts` (`OLLAMA_API_ENDPOINT` >
 * `OLLAMA_API_URL` > `OLLAMA_BASE_URL` > localhost) and the OpenAI precedence
 * mirrors `plugins/plugin-openai/utils/config.ts` (`OPENAI_BASE_URL` > the
 * public API). Callers supply a reader so the same rules serve `process.env`,
 * runtime settings, or a test map.
 *
 * Classification only labels an endpoint for display; it is not an SSRF
 * decision. Outbound requests to configured endpoints still go through the
 * guarded fetch path that owns that policy.
 */

import { isBlockedHostname, isPrivateIpAddress } from "@elizaos/core";

/** Reads one setting; blank and missing values are both treated as unset. */
export type ModelEndpointSettingReader = (
  key: string,
) => string | null | undefined;

export const OLLAMA_ENDPOINT_SETTING_KEYS = [
  "OLLAMA_API_ENDPOINT",
  "OLLAMA_API_URL",
  "OLLAMA_BASE_URL",
] as const;
export type OllamaEndpointSettingKey =
  (typeof OLLAMA_ENDPOINT_SETTING_KEYS)[number];

export const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";
export const OPENAI_ENDPOINT_SETTING_KEY = "OPENAI_BASE_URL";
export const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1";

export type ModelEndpointTransport =
  | "https"
  | "http-loopback"
  | "http-private"
  | "http-public";

export interface ResolvedModelEndpoint {
  /** Endpoint base with trailing slashes removed. */
  url: string;
  /** The setting key that supplied `url`, or null for the built-in default. */
  source: string | null;
  isDefault: boolean;
}

function readSetting(
  get: ModelEndpointSettingReader,
  key: string,
): string | null {
  const value = get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Resolve the Ollama server base (without the `/api` suffix the plugin
 * appends) using the plugin's own precedence.
 */
export function resolveOllamaEndpoint(
  get: ModelEndpointSettingReader,
): ResolvedModelEndpoint {
  for (const key of OLLAMA_ENDPOINT_SETTING_KEYS) {
    const value = readSetting(get, key);
    if (value === null) continue;
    const base = stripTrailingSlashes(value).replace(/\/api$/, "");
    return { url: stripTrailingSlashes(base), source: key, isDefault: false };
  }
  return { url: DEFAULT_OLLAMA_ENDPOINT, source: null, isDefault: true };
}

/** Resolve the OpenAI-compatible API base, including its `/v1` path. */
export function resolveOpenAiEndpoint(
  get: ModelEndpointSettingReader,
): ResolvedModelEndpoint {
  const value = readSetting(get, OPENAI_ENDPOINT_SETTING_KEY);
  if (value === null) {
    return { url: DEFAULT_OPENAI_ENDPOINT, source: null, isDefault: true };
  }
  return {
    url: stripTrailingSlashes(value),
    source: OPENAI_ENDPOINT_SETTING_KEY,
    isDefault: false,
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") {
    return true;
  }
  // WHATWG URL parsing already canonicalizes short and numeric IPv4 forms.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Label an endpoint by how its traffic travels. Returns null when the value
 * is not an absolute http(s) URL, so callers can show an explicit invalid
 * state instead of a guessed label.
 */
export function classifyModelEndpointTransport(
  url: string,
): ModelEndpointTransport | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // error-policy:J3 an unparsable URL is reported as unclassifiable.
    return null;
  }
  if (parsed.protocol === "https:") return "https";
  if (parsed.protocol !== "http:") return null;
  const host = parsed.hostname;
  if (isLoopbackHostname(host)) return "http-loopback";
  const bareHost = host.replace(/^\[|\]$/g, "");
  if (isPrivateIpAddress(bareHost) || isBlockedHostname(bareHost)) {
    return "http-private";
  }
  return "http-public";
}
