/**
 * Coverage for the model-resolution helpers in ./model-resolution.ts: primary
 * model id extraction, provider id resolution across transport/backend
 * combinations, the provider-to-plugin mapping, and the boot-time pin after
 * the direct-provider model gate. Runs against the real
 * @elizaos/shared first-run provider catalog and service-routing resolver —
 * those helpers are pure config readers, so no mocking is needed.
 */
import type { ElizaConfig } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  resolveBootTextProvider,
  resolvePreferredProviderId,
  resolvePreferredProviderPluginName,
  resolvePrimaryModel,
} from "./model-resolution.ts";

describe("resolvePrimaryModel", () => {
  it("returns undefined when no model config exists", () => {
    expect(resolvePrimaryModel({})).toBeUndefined();
    expect(resolvePrimaryModel({ agents: {} })).toBeUndefined();
    expect(resolvePrimaryModel({ agents: { defaults: {} } })).toBeUndefined();
  });

  it("returns the primary model id when configured", () => {
    const config: ElizaConfig = {
      agents: { defaults: { model: { primary: "deepseek-chat" } } },
    };
    expect(resolvePrimaryModel(config)).toBe("deepseek-chat");
  });
});

describe("resolvePreferredProviderId", () => {
  it("returns elizacloud for a cloud-proxy transport onto the cloud backend", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "cloud-proxy", backend: "elizacloud" },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("elizacloud");
  });

  it("returns the direct backend when it is not elizacloud", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "direct", backend: "anthropic" },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("anthropic");
  });

  it("falls back to the model-name hint for a direct transport without a backend", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "direct", primaryModel: "openai/gpt-4o" },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("openai");
  });

  it("falls back to the model-name hint for a remote transport without a backend", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "remote", primaryModel: "anthropic/claude" },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("anthropic");
  });

  it("ignores an elizacloud backend on a direct transport and uses the hint", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: {
          transport: "direct",
          backend: "elizacloud",
          primaryModel: "openai/gpt-4o",
        },
      },
    };
    expect(resolvePreferredProviderId(config)).toBe("openai");
  });

  it("derives the provider from the configured primary model when routing is absent", () => {
    const config: ElizaConfig = {
      serviceRouting: {},
      agents: { defaults: { model: { primary: "anthropic/claude" } } },
    };
    expect(resolvePreferredProviderId(config)).toBe("anthropic");
  });

  it("returns undefined when nothing is configured", () => {
    expect(resolvePreferredProviderId({ serviceRouting: {} })).toBeUndefined();
  });
});

describe("resolvePreferredProviderPluginName", () => {
  it("maps a resolved provider id to its plugin package name", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "direct", backend: "anthropic" },
      },
    };
    expect(resolvePreferredProviderPluginName(config)).toBe(
      "@elizaos/plugin-anthropic",
    );
  });

  it("returns undefined when no provider is resolved", () => {
    expect(
      resolvePreferredProviderPluginName({ serviceRouting: {} }),
    ).toBeUndefined();
  });

  it("maps a direct Grok route to the installed OpenAI-compatible plugin", () => {
    for (const backend of ["grok", "xai"]) {
      const config: ElizaConfig = {
        serviceRouting: {
          llmText: { transport: "direct", backend },
        },
      };
      expect(resolvePreferredProviderId(config)).toBe("grok");
      expect(resolvePreferredProviderPluginName(config)).toBe(
        "@elizaos/plugin-openai",
      );
    }
  });
});

describe("resolveBootTextProvider", () => {
  it("pins nothing for a direct Grok route without both models", () => {
    for (const models of [{}, { smallModel: "grok-4-fast" }]) {
      const boot = resolveBootTextProvider({
        serviceRouting: {
          llmText: { transport: "direct", backend: "grok", ...models },
        },
      });
      expect(boot.preferredProviderId).toBeUndefined();
      expect(boot.preferredProviderPluginName).toBeUndefined();
      expect(boot.modelSelection.state).toBe("models-required");
    }
  });

  it("pins Grok to the OpenAI-compatible plugin once both models are chosen", () => {
    const boot = resolveBootTextProvider({
      serviceRouting: {
        llmText: {
          transport: "direct",
          backend: "grok",
          smallModel: "grok-4-fast",
          largeModel: "grok-4",
        },
      },
    });
    expect(boot.preferredProviderId).toBe("grok");
    expect(boot.preferredProviderPluginName).toBe("@elizaos/plugin-openai");
    expect(boot.modelSelection.state).toBe("ready");
  });

  it("matches the plain resolvers for providers with default models", () => {
    const config: ElizaConfig = {
      serviceRouting: {
        llmText: { transport: "direct", backend: "anthropic" },
      },
    };
    const boot = resolveBootTextProvider(config);
    expect(boot.preferredProviderId).toBe(resolvePreferredProviderId(config));
    expect(boot.preferredProviderPluginName).toBe(
      resolvePreferredProviderPluginName(config),
    );
  });
});
