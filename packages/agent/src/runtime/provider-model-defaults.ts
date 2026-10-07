/**
 * Provider model-env defaults seeded synchronously by runtime boot before
 * provider selection and plugin initialization. Lives apart from the boot
 * monolith so the seeding rules are unit-testable and have one owner.
 *
 * Seeding order matters: every default here is set-if-missing, so explicit
 * operator config (env or character settings folded into env) always wins.
 * The one deliberate override is `applyDirectProviderModelEnv`: models the
 * owner picked for a direct provider in `serviceRouting.llmText` are mapped to
 * that provider plugin's env keys and replace earlier values.
 */
import {
  DEFAULT_CEREBRAS_TEXT_MODEL,
  normalizeFirstRunProviderId,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";

/** Set an env default without clobbering an operator-provided value. */
export function setEnvIfMissing(key: string, value: string | undefined): void {
  if (!value || process.env[key]) return;
  process.env[key] = value;
}

/**
 * True for model ids that identify OpenAI-only text families. Open-weight GPT
 * OSS ids are deliberately excluded because Groq, Cerebras, and other
 * OpenAI-compatible providers serve them too.
 */
export function isLikelyOpenAiTextModel(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;

  const hasOpenAiNamespace = normalized.startsWith("openai/");
  const unqualified = hasOpenAiNamespace
    ? normalized.slice("openai/".length)
    : normalized;
  // Only bare, portable GPT-OSS model ids are safe to copy into direct Groq
  // or Cerebras configuration. Router variants such as :nitro/:free/:online
  // are provider-specific and must fall through to the conservative path.
  if (/^gpt-oss-(?:\d+b|safeguard-\d+b)$/.test(unqualified)) return false;
  if (hasOpenAiNamespace) return true;

  const model = unqualified.startsWith("ft:")
    ? unqualified.slice("ft:".length)
    : unqualified;
  return (
    model.startsWith("gpt-") ||
    model.startsWith("chatgpt-") ||
    model.startsWith("codex-") ||
    /^o[134](?:-|$)/.test(model)
  );
}

export function applyProviderModelEnvDefaults(): void {
  // Normalize Google AI API key aliases — the elizaOS plugin and @google/genai
  // SDK expect different env var names. Canonicalize to the long form that
  // @elizaos/plugin-google-genai reads via runtime.getSetting(). Users can set
  // any of: GEMINI_API_KEY, GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY.
  setEnvIfMissing(
    "GOOGLE_GENERATIVE_AI_API_KEY",
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  );

  // Default Google model names — the Google GenAI plugin's getSetting() returns
  // null (not undefined) for missing keys, but the plugin checks !== undefined
  // causing String(null) = "null" to be sent as the model name. Set sensible
  // defaults so the plugin always has valid model names.
  setEnvIfMissing("GOOGLE_SMALL_MODEL", "gemini-3-flash-preview");
  setEnvIfMissing("GOOGLE_LARGE_MODEL", "gemini-3.1-pro-preview");

  // Default Groq model names — plugin-groq still ships a deprecated large-model
  // fallback. Seed runtime defaults before plugin init so direct Groq provider
  // sessions use the approved GPT-OSS default.
  const currentSharedSmallModel =
    process.env.OPENAI_SMALL_MODEL ?? process.env.SMALL_MODEL;
  const currentSharedLargeModel =
    process.env.OPENAI_LARGE_MODEL ?? process.env.LARGE_MODEL;
  setEnvIfMissing(
    "GROQ_SMALL_MODEL",
    currentSharedSmallModel && !isLikelyOpenAiTextModel(currentSharedSmallModel)
      ? currentSharedSmallModel
      : "openai/gpt-oss-120b",
  );
  setEnvIfMissing(
    "GROQ_LARGE_MODEL",
    currentSharedLargeModel && !isLikelyOpenAiTextModel(currentSharedLargeModel)
      ? currentSharedLargeModel
      : "openai/gpt-oss-120b",
  );

  // Seed independent Cerebras tiers from the matching shared tiers. Keep an
  // explicit legacy CEREBRAS_MODEL authoritative for every role; operators
  // using that compatibility alias intentionally selected one provider model.
  const explicitLegacyCerebrasModel = process.env.CEREBRAS_MODEL;
  const cerebrasSmallModel =
    currentSharedSmallModel && !isLikelyOpenAiTextModel(currentSharedSmallModel)
      ? currentSharedSmallModel
      : DEFAULT_CEREBRAS_TEXT_MODEL;
  if (!explicitLegacyCerebrasModel) {
    setEnvIfMissing("CEREBRAS_SMALL_MODEL", cerebrasSmallModel);
    setEnvIfMissing(
      "CEREBRAS_LARGE_MODEL",
      currentSharedLargeModel &&
        !isLikelyOpenAiTextModel(currentSharedLargeModel)
        ? currentSharedLargeModel
        : cerebrasSmallModel,
    );
  }
  setEnvIfMissing(
    "CEREBRAS_MODEL",
    process.env.CEREBRAS_SMALL_MODEL ?? cerebrasSmallModel,
  );
}

/**
 * Env keys through which each direct provider plugin reads its small and
 * large model ids. Grok runs through plugin-openai (the account pool exports
 * the xAI key as an OpenAI-compatible credential), so it shares OpenAI's keys.
 */
export const DIRECT_PROVIDER_MODEL_ENV_KEYS: Readonly<
  Record<string, { small: string; large: string }>
> = {
  openai: { small: "OPENAI_SMALL_MODEL", large: "OPENAI_LARGE_MODEL" },
  grok: { small: "OPENAI_SMALL_MODEL", large: "OPENAI_LARGE_MODEL" },
  anthropic: { small: "ANTHROPIC_SMALL_MODEL", large: "ANTHROPIC_LARGE_MODEL" },
  ollama: { small: "OLLAMA_SMALL_MODEL", large: "OLLAMA_LARGE_MODEL" },
};

export interface DirectProviderModelEnv {
  provider: string;
  smallKey: string;
  largeKey: string;
  /** Assignments derived from the route; a tier the owner did not pick is absent. */
  assignments: Record<string, string>;
}

function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Pure: derive the model env assignments for the direct text route in
 * `config`. Returns null when text is not routed directly to a provider in
 * {@link DIRECT_PROVIDER_MODEL_ENV_KEYS}; cloud model env stays owned by the
 * cloud projection.
 */
export function resolveDirectProviderModelEnv(config: {
  serviceRouting?: unknown;
}): DirectProviderModelEnv | null {
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  if (llmText?.transport !== "direct") return null;
  const provider = normalizeFirstRunProviderId(llmText.backend);
  if (!provider) return null;
  const keys = DIRECT_PROVIDER_MODEL_ENV_KEYS[provider];
  if (!keys) return null;
  const assignments: Record<string, string> = {};
  const small = trimmedOrUndefined(llmText.smallModel);
  const large = trimmedOrUndefined(llmText.largeModel);
  if (small) assignments[keys.small] = small;
  if (large) assignments[keys.large] = large;
  return { provider, smallKey: keys.small, largeKey: keys.large, assignments };
}

/**
 * Write the owner's direct-provider model selection into `env`. Boot calls it
 * for `process.env` and for the in-memory `config.env` that feeds runtime
 * settings (which plugins read before `process.env`); activation calls it
 * after persisting a new selection.
 */
export function applyDirectProviderModelEnv(
  config: { serviceRouting?: unknown },
  env: Record<string, unknown>,
): DirectProviderModelEnv | null {
  const resolved = resolveDirectProviderModelEnv(config);
  if (!resolved) return null;
  for (const [key, value] of Object.entries(resolved.assignments)) {
    env[key] = value;
  }
  return resolved;
}
