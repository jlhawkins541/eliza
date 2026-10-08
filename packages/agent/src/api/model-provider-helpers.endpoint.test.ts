/**
 * Endpoint resolution for model catalog listing. Drives the real catalog
 * helpers and cache against a temp state directory; only the global `fetch`
 * transport is stubbed so the requested host can be observed without a live
 * Ollama or OpenAI-compatible server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchOllamaModels,
  getOrFetchProvider,
  probeOpenAiCompatibleCatalog,
  readProviderCache,
  resolveProviderCatalogEndpoint,
} from "./model-provider-helpers.ts";

const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "OLLAMA_API_ENDPOINT",
  "OLLAMA_API_URL",
  "OLLAMA_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

let savedEnv: Record<string, string | undefined>;
let stateDir: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-model-catalog-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Ollama catalog endpoint", () => {
  it("lists models from the configured LAN host, not localhost", async () => {
    process.env.OLLAMA_BASE_URL = "http://192.168.1.50:11434";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ models: [{ name: "llama3.2:3b" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const models = await getOrFetchProvider("ollama", true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://192.168.1.50:11434/api/tags",
    );
    expect(models.map((model) => model.id)).toEqual(["llama3.2:3b"]);
  });

  it("follows the plugin precedence across the three Ollama keys", () => {
    process.env.OLLAMA_BASE_URL = "http://10.0.0.3:11434";
    process.env.OLLAMA_API_URL = "http://10.0.0.2:11434/";
    process.env.OLLAMA_API_ENDPOINT = "http://10.0.0.1:11434/api";
    expect(resolveProviderCatalogEndpoint("ollama")).toBe(
      "http://10.0.0.1:11434",
    );
    delete process.env.OLLAMA_API_ENDPOINT;
    expect(resolveProviderCatalogEndpoint("ollama")).toBe(
      "http://10.0.0.2:11434",
    );
  });

  it("reports an unreachable endpoint as unreachable, never as no models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed: connect ECONNREFUSED");
      }),
    );
    const probe = await fetchOllamaModels("http://192.168.1.50:11434");
    expect(probe).toEqual({
      state: "unreachable",
      detail: "fetch failed: connect ECONNREFUSED",
    });
  });

  it("separates a reachable server with no pulled models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ models: [] })),
    );
    await expect(
      fetchOllamaModels("http://192.168.1.50:11434"),
    ).resolves.toEqual({ state: "no-models" });
  });
});

describe("OpenAI-compatible catalog endpoint", () => {
  it("lists models from OPENAI_BASE_URL when it is configured", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://llm.example.test/v1/";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      jsonResponse({ data: [{ id: "custom-large" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getOrFetchProvider("openai", true);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://llm.example.test/v1/models",
    );
  });

  it("does not serve a cached catalog fetched from a different endpoint", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_BASE_URL = "https://first.example.test/v1";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      jsonResponse({
        data: [
          {
            id: String(input).includes("first")
              ? "first-model"
              : "second-model",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getOrFetchProvider("openai", true);
    process.env.OPENAI_BASE_URL = "https://second.example.test/v1";
    const models = await getOrFetchProvider("openai");

    expect(models.map((model) => model.id)).toEqual(["second-model"]);
    expect(
      readProviderCache("openai", {
        endpoint: "https://second.example.test/v1",
      })?.models.map((model) => model.id),
    ).toEqual(["second-model"]);
  });

  it("classifies a rejected key as auth-failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "bad key" }, 401)),
    );
    await expect(
      probeOpenAiCompatibleCatalog("openai", "sk-bad", "https://api.test/v1"),
    ).resolves.toEqual({ state: "auth-failed", detail: "HTTP 401" });
  });
});
