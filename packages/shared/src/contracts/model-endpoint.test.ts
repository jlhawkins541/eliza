/**
 * Pure tests for model endpoint resolution and transport labels. Exercises the
 * real resolver against plain setting maps; no network or mocks.
 */
import { describe, expect, it } from "vitest";
import {
  classifyModelEndpointTransport,
  DEFAULT_OLLAMA_ENDPOINT,
  DEFAULT_OPENAI_ENDPOINT,
  resolveOllamaEndpoint,
  resolveOpenAiEndpoint,
} from "./model-endpoint.ts";

function reader(values: Record<string, string>) {
  return (key: string) => values[key];
}

describe("resolveOllamaEndpoint", () => {
  it("uses localhost only when no key is configured", () => {
    expect(resolveOllamaEndpoint(reader({}))).toEqual({
      url: DEFAULT_OLLAMA_ENDPOINT,
      source: null,
      isDefault: true,
    });
  });

  it("prefers OLLAMA_API_ENDPOINT, then OLLAMA_API_URL, then OLLAMA_BASE_URL", () => {
    const all = {
      OLLAMA_API_ENDPOINT: "http://10.0.0.1:11434",
      OLLAMA_API_URL: "http://10.0.0.2:11434",
      OLLAMA_BASE_URL: "http://10.0.0.3:11434",
    };
    expect(resolveOllamaEndpoint(reader(all)).source).toBe(
      "OLLAMA_API_ENDPOINT",
    );
    const { OLLAMA_API_ENDPOINT: _first, ...rest } = all;
    expect(resolveOllamaEndpoint(reader(rest))).toMatchObject({
      url: "http://10.0.0.2:11434",
      source: "OLLAMA_API_URL",
    });
    expect(
      resolveOllamaEndpoint(
        reader({ OLLAMA_BASE_URL: "http://192.168.1.50:11434" }),
      ),
    ).toEqual({
      url: "http://192.168.1.50:11434",
      source: "OLLAMA_BASE_URL",
      isDefault: false,
    });
  });

  it("treats blank values as unset and strips the plugin's /api suffix", () => {
    expect(
      resolveOllamaEndpoint(
        reader({
          OLLAMA_API_ENDPOINT: "   ",
          OLLAMA_BASE_URL: "http://gpu-box.local:11434/api/",
        }),
      ),
    ).toMatchObject({
      url: "http://gpu-box.local:11434",
      source: "OLLAMA_BASE_URL",
    });
  });
});

describe("resolveOpenAiEndpoint", () => {
  it("returns the public API by default and the configured base otherwise", () => {
    expect(resolveOpenAiEndpoint(reader({}))).toEqual({
      url: DEFAULT_OPENAI_ENDPOINT,
      source: null,
      isDefault: true,
    });
    expect(
      resolveOpenAiEndpoint(
        reader({ OPENAI_BASE_URL: "https://api.x.ai/v1/" }),
      ),
    ).toEqual({
      url: "https://api.x.ai/v1",
      source: "OPENAI_BASE_URL",
      isDefault: false,
    });
  });
});

describe("classifyModelEndpointTransport", () => {
  it.each([
    ["https://api.openai.com/v1", "https"],
    ["http://localhost:11434", "http-loopback"],
    ["http://127.0.0.1:11434", "http-loopback"],
    ["http://[::1]:11434", "http-loopback"],
    ["http://192.168.1.50:11434", "http-private"],
    ["http://10.1.2.3:11434", "http-private"],
    ["http://gpu-box.local:11434", "http-private"],
    ["http://203.0.113.9:11434", "http-public"],
    ["http://ollama.example.com", "http-public"],
  ] as const)("labels %s as %s", (url, expected) => {
    expect(classifyModelEndpointTransport(url)).toBe(expected);
  });

  it("returns null for values that are not absolute http(s) URLs", () => {
    expect(classifyModelEndpointTransport("192.168.1.50:11434")).toBeNull();
    expect(classifyModelEndpointTransport("ftp://host/models")).toBeNull();
    expect(classifyModelEndpointTransport("")).toBeNull();
  });
});
