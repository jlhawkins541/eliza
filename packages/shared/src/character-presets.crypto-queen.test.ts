/** Verifies the recovered research persona through the production preset and catalog paths. */
import { afterEach, describe, expect, it } from "vitest";
import { CHARACTER_LANGUAGES } from "./contracts/first-run-options.js";
import {
  buildElizaCharacterCatalog,
  getDefaultStylePreset,
  getStylePresets,
  resolveStylePresetByAvatarIndex,
  resolveStylePresetById,
  resolveStylePresetByName,
  setDefaultAgentName,
} from "./character-presets.js";

afterEach(() => setDefaultAgentName(null));

describe("recovered Crypto Queen preset", () => {
  it("is available in every supported language with normalized conversation roles", () => {
    for (const language of CHARACTER_LANGUAGES) {
      const preset = resolveStylePresetById("crypto-queen", language);
      expect(preset).toBeDefined();
      expect(
        getStylePresets(language).filter(({ id }) => id === "crypto-queen"),
      ).toHaveLength(1);
      expect(resolveStylePresetByName("Crypto Queen", language)?.id).toBe(
        preset?.id,
      );
      expect(preset?.catchphrase).toBeTruthy();
      expect(preset?.hint).toBeTruthy();
      expect(preset?.postExamples.length).toBeGreaterThan(0);
      for (const conversation of preset?.messageExamples ?? []) {
        expect(conversation.map(({ user }) => user)).toEqual([
          "{{user1}}",
          "{{agentName}}",
        ]);
      }
    }
  });

  it("registers one persona using existing assets without displacing the default avatar", () => {
    const preset = resolveStylePresetById("crypto-queen");
    const catalog = buildElizaCharacterCatalog();
    const entries = catalog.injectedCharacters.filter(
      ({ name }) => name === "Crypto Queen",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.avatarAssetId).toBe(preset?.avatarIndex);
    expect(
      catalog.assets.filter(({ id }) => id === preset?.avatarIndex),
    ).toHaveLength(1);
    expect(resolveStylePresetByAvatarIndex(preset?.avatarIndex)?.id).toBe(
      "eliza",
    );
    expect(getDefaultStylePreset().id).toBe("eliza");
  });

  it("keeps a named research persona when the default agent is renamed", () => {
    setDefaultAgentName("My Companion");
    expect(getDefaultStylePreset().name).toBe("My Companion");
    expect(resolveStylePresetById("crypto-queen")?.name).toBe("Crypto Queen");
    expect(
      buildElizaCharacterCatalog().injectedCharacters.filter(
        ({ name }) => name === "Crypto Queen",
      ),
    ).toHaveLength(1);
  });
});
