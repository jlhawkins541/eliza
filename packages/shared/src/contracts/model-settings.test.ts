/**
 * Schema tests for the model settings wire contract: the activation request
 * grammar (strict fields, required Grok models, bounded ids) and the status
 * and catalog DTO shapes. Pure zod parsing; no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  CredentialStatusSchema,
  isActivatableModelProviderId,
  MODEL_ID_MAX_LENGTH,
  ModelSettingsStatusSchema,
  PostActivateModelRequestSchema,
  ProviderModelCatalogSchema,
  providerRequiresModelSelection,
} from "./model-settings.ts";

describe("PostActivateModelRequestSchema", () => {
  it("accepts a provider with optional models and trims ids", () => {
    expect(
      PostActivateModelRequestSchema.parse({
        provider: "anthropic",
        largeModel: "  claude-opus-4-8 ",
      }),
    ).toEqual({ provider: "anthropic", largeModel: "claude-opus-4-8" });
    expect(
      PostActivateModelRequestSchema.parse({ provider: "ollama" }),
    ).toEqual({ provider: "ollama" });
  });

  it("rejects unknown fields, including an API key", () => {
    const result = PostActivateModelRequestSchema.safeParse({
      provider: "openai",
      apiKey: "sk-should-never-travel-here",
    });
    expect(result.success).toBe(false);
  });

  it("rejects providers the page cannot activate", () => {
    for (const provider of ["local", "groq", "", "OPENAI"]) {
      expect(
        PostActivateModelRequestSchema.safeParse({ provider }).success,
      ).toBe(false);
    }
  });

  it("requires both Grok tiers and tags the issue MODEL_REQUIRED", () => {
    const result = PostActivateModelRequestSchema.safeParse({
      provider: "grok",
      smallModel: "grok-4-fast",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.path).toEqual(["largeModel"]);
    expect(
      (result.error.issues[0] as { params?: { reason?: string } }).params
        ?.reason,
    ).toBe("MODEL_REQUIRED");
    expect(
      PostActivateModelRequestSchema.safeParse({
        provider: "grok",
        smallModel: "grok-4-fast",
        largeModel: "grok-4",
      }).success,
    ).toBe(true);
  });

  it("rejects blank and over-long model ids", () => {
    expect(
      PostActivateModelRequestSchema.safeParse({
        provider: "openai",
        smallModel: "   ",
      }).success,
    ).toBe(false);
    expect(
      PostActivateModelRequestSchema.safeParse({
        provider: "openai",
        smallModel: "m".repeat(MODEL_ID_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
});

describe("provider helpers", () => {
  it("classifies activatable and model-required providers", () => {
    expect(isActivatableModelProviderId("grok")).toBe(true);
    expect(isActivatableModelProviderId("local")).toBe(false);
    expect(providerRequiresModelSelection("grok")).toBe(true);
    expect(providerRequiresModelSelection("openai")).toBe(false);
  });
});

describe("status and catalog DTOs", () => {
  const unchecked = { state: "unchecked", checkedAt: null, detail: null };

  it("describes a stored credential by last4 only", () => {
    expect(
      CredentialStatusSchema.safeParse({
        state: "stored",
        last4: "wxyz",
        source: "account-pool",
        lastVerifiedAt: null,
        health: unchecked,
      }).success,
    ).toBe(true);
    expect(
      CredentialStatusSchema.safeParse({
        state: "stored",
        last4: "sk-full-key-material",
        source: "account-pool",
        lastVerifiedAt: null,
        health: unchecked,
      }).success,
    ).toBe(false);
  });

  it("accepts a complete status DTO and rejects a missing field", () => {
    const status = {
      active: {
        provider: "openai",
        providerLabel: "OpenAI",
        runtimeProviderName: "openai",
        smallModel: "gpt-5.6-luna",
        largeModel: "gpt-5.6-sol",
        smallModelSource: "user",
        largeModelSource: "provider-default",
        endpoint: {
          url: "https://api.openai.com/v1",
          isDefault: true,
          transport: "https",
          overriddenBy: null,
        },
        health: unchecked,
      },
      providers: [],
      operation: null,
      managedByCloud: false,
    };
    expect(ModelSettingsStatusSchema.safeParse(status).success).toBe(true);
    const { managedByCloud: _omitted, ...incomplete } = status;
    expect(ModelSettingsStatusSchema.safeParse(incomplete).success).toBe(false);
    const { largeModelSource: _tier, ...oneTierSource } = status.active;
    expect(
      ModelSettingsStatusSchema.safeParse({ ...status, active: oneTierSource })
        .success,
    ).toBe(false);
  });

  it("represents an unconfigured provider label as null, not a display string", () => {
    const unconfigured = {
      active: {
        provider: "other",
        providerLabel: null,
        runtimeProviderName: null,
        smallModel: null,
        largeModel: null,
        smallModelSource: "unknown",
        largeModelSource: "unknown",
        endpoint: null,
        health: unchecked,
      },
      providers: [],
      operation: null,
      managedByCloud: false,
    };
    expect(ModelSettingsStatusSchema.safeParse(unconfigured).success).toBe(
      true,
    );
  });

  it("never represents an unreachable catalog as an empty model list", () => {
    expect(
      ProviderModelCatalogSchema.safeParse({
        provider: "ollama",
        state: "ok",
        models: [],
        fetchedAt: "2026-10-05T00:00:00.000Z",
      }).success,
    ).toBe(false);
    expect(
      ProviderModelCatalogSchema.safeParse({
        provider: "ollama",
        state: "unreachable",
        detail: "connect ECONNREFUSED",
        fetchedAt: "2026-10-05T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});
