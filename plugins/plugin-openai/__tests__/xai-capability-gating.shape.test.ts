/**
 * Shape test for the xAI endpoint gate: when the account pool points this
 * plugin at api.x.ai (the active Grok route), capabilities whose default model
 * id is OpenAI-only stay unregistered unless a per-capability endpoint or
 * model override is set, so none of those defaults can be sent to xAI.
 * Deterministic: a recording runtime stands in for AgentRuntime registration.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import openaiPlugin from "../index";
import { isXaiBaseURL } from "../utils/config";

const OPENAI_DEFAULT_MODEL_TYPES = [
  ModelType.IMAGE,
  ModelType.IMAGE_DESCRIPTION,
  ModelType.TRANSCRIPTION,
  ModelType.TEXT_TO_SPEECH,
  ModelType.TEXT_EMBEDDING,
  ModelType.RESEARCH,
] as const;

const ENV_KEYS = [
  "ELIZA_PROVIDER",
  "ELIZA_MOCK_OPENAI_BASE",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "EVOLINK_API_KEY",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_IMAGE_DESCRIPTION_BASE_URL",
  "OPENAI_IMAGE_DESCRIPTION_MODEL",
  "OPENAI_TRANSCRIPTION_MODEL",
  "OPENAI_TTS_MODEL",
  "OPENAI_EMBEDDING_URL",
  "OPENAI_BROWSER_EMBEDDING_URL",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_RESEARCH_MODEL",
] as const;

const XAI = "https://api.x.ai/v1";
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
  vi.restoreAllMocks();
});

async function registeredAfterInit(settings: Record<string, string>): Promise<string[]> {
  const registerModel = vi.fn();
  const runtime = {
    getSetting: vi.fn((key: string) => settings[key] ?? null),
    registerModel,
  } as unknown as IAgentRuntime;
  await openaiPlugin.init?.({}, runtime);
  return [
    ...registerModel.mock.calls.map((call) => String(call[0])),
    ...Object.keys(openaiPlugin.models ?? {}),
  ];
}

describe("plugin-openai xAI capability gating", () => {
  it("recognizes xAI hosts only", () => {
    expect(isXaiBaseURL(XAI)).toBe(true);
    expect(isXaiBaseURL("https://x.ai/v1")).toBe(true);
    expect(isXaiBaseURL(" HTTPS://API.X.AI:443/v1 ")).toBe(true);
    expect(isXaiBaseURL("https://api.openai.com/v1")).toBe(false);
    expect(isXaiBaseURL("https://notx.ai/v1")).toBe(false);
    expect(isXaiBaseURL("https://x.ai.example.com/v1")).toBe(false);
    expect(isXaiBaseURL("https://proxy.example.com/x.ai/v1")).toBe(false);
    expect(isXaiBaseURL("not a url")).toBe(false);
  });

  it("keeps the endpoint-gated capabilities out of the static models map", () => {
    for (const modelType of OPENAI_DEFAULT_MODEL_TYPES) {
      expect(openaiPlugin.models?.[modelType]).toBeUndefined();
    }
  });

  it("registers no OpenAI-default capability against api.x.ai (the Grok route)", async () => {
    const registered = await registeredAfterInit({
      OPENAI_API_KEY: "xai-fixture-key",
      OPENAI_BASE_URL: XAI,
    });

    for (const modelType of OPENAI_DEFAULT_MODEL_TYPES) {
      expect(registered).not.toContain(modelType);
    }
    // Text tiers stay: their model ids come from the owner's Grok selection.
    expect(registered).toContain(ModelType.TEXT_SMALL);
    expect(registered).toContain(ModelType.TEXT_LARGE);
  });

  it("applies the gate when the xAI base URL reaches the plugin through process env", async () => {
    process.env.OPENAI_BASE_URL = XAI;
    const registered = await registeredAfterInit({ OPENAI_API_KEY: "xai-fixture-key" });
    for (const modelType of OPENAI_DEFAULT_MODEL_TYPES) {
      expect(registered).not.toContain(modelType);
    }
  });

  it("registers each capability once its own override is set", async () => {
    const registered = await registeredAfterInit({
      OPENAI_API_KEY: "xai-fixture-key",
      OPENAI_BASE_URL: XAI,
      OPENAI_IMAGE_MODEL: "grok-2-image",
      OPENAI_IMAGE_DESCRIPTION_MODEL: "grok-2-vision",
      OPENAI_EMBEDDING_URL: "https://embeddings.example.com/v1",
    });

    expect(registered).toContain(ModelType.IMAGE);
    expect(registered).toContain(ModelType.IMAGE_DESCRIPTION);
    expect(registered).toContain(ModelType.TEXT_EMBEDDING);
    // Overrides are per capability: the others stay gated.
    expect(registered).not.toContain(ModelType.TRANSCRIPTION);
    expect(registered).not.toContain(ModelType.TEXT_TO_SPEECH);
    expect(registered).not.toContain(ModelType.RESEARCH);
  });

  it("registers every capability against the default OpenAI endpoint", async () => {
    const registered = await registeredAfterInit({ OPENAI_API_KEY: "sk-openai-fixture" });
    for (const modelType of OPENAI_DEFAULT_MODEL_TYPES) {
      expect(registered).toContain(modelType);
    }
  });
});
