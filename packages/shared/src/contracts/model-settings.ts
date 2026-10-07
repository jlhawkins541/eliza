/**
 * Wire contract for the owner-only model settings surface
 * (`/api/model-settings`): which provider and models Eliza is using, each
 * switchable provider's credential and endpoint status, the provider model
 * catalogs, and the activation request.
 *
 * The agent host produces these DTOs and the Models page renders them. Every
 * field is required; a value the host could not determine is an explicit
 * state (`unchecked`, `missing`, `unknown`, or `null` where documented), never
 * an empty string or a fabricated default. Credential values never cross this
 * boundary: a stored key is described by its last four characters only.
 */

import z from "zod";

/** Providers the Models page shows. `local` is the on-device runtime. */
export const MODEL_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "grok",
  "ollama",
  "elizacloud",
  "local",
] as const;
export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

/**
 * Providers the activation route can switch to. On-device inference is
 * selected through the existing local-only flow, which also signs out of
 * Eliza Cloud, so it is not a model-settings activation.
 */
export const ACTIVATABLE_MODEL_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "grok",
  "ollama",
  "elizacloud",
] as const;
export type ActivatableModelProviderId =
  (typeof ACTIVATABLE_MODEL_PROVIDER_IDS)[number];

/**
 * Providers with no built-in model ids anywhere in the stack. Activating one
 * requires both tiers picked from its live catalog, so a request can never
 * fall back to another provider's model ids.
 */
export const MODEL_REQUIRED_PROVIDER_IDS = [
  "grok",
] as const satisfies readonly ActivatableModelProviderId[];

/** Path-segment grammar for `/api/model-settings/providers/:id/...`. */
export const MODEL_SETTINGS_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Upper bound on a model id; provider ids are far shorter in practice. */
export const MODEL_ID_MAX_LENGTH = 256;

export function isModelProviderId(value: unknown): value is ModelProviderId {
  return (
    typeof value === "string" &&
    (MODEL_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export function isActivatableModelProviderId(
  value: unknown,
): value is ActivatableModelProviderId {
  return (
    typeof value === "string" &&
    (ACTIVATABLE_MODEL_PROVIDER_IDS as readonly string[]).includes(value)
  );
}

export function providerRequiresModelSelection(
  provider: ActivatableModelProviderId,
): boolean {
  return (MODEL_REQUIRED_PROVIDER_IDS as readonly string[]).includes(provider);
}

export const ProviderHealthStateSchema = z.enum([
  "ok",
  "unreachable",
  "auth-failed",
  "no-models",
  "unchecked",
]);

export const ProviderHealthSchema = z
  .object({
    state: ProviderHealthStateSchema,
    /** ISO timestamp of the observation; null when never checked. */
    checkedAt: z.string().nullable(),
    /** Short diagnostic (HTTP status or transport error); never a secret. */
    detail: z.string().nullable(),
  })
  .strict();
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const CredentialSourceSchema = z.enum([
  "account-pool",
  "launch-env",
  "cloud-account",
]);

export const CredentialStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not-required") }).strict(),
  z.object({ state: z.literal("missing") }).strict(),
  z
    .object({
      state: z.literal("stored"),
      last4: z.string().min(1).max(4),
      source: CredentialSourceSchema,
      lastVerifiedAt: z.string().nullable(),
      health: ProviderHealthSchema,
    })
    .strict(),
]);
export type CredentialStatus = z.infer<typeof CredentialStatusSchema>;

export const EndpointTransportSchema = z.enum([
  "https",
  "http-loopback",
  "http-private",
  "http-public",
  "invalid",
]);

export const EndpointStatusSchema = z
  .object({
    url: z.string(),
    isDefault: z.boolean(),
    transport: EndpointTransportSchema,
    /**
     * Setting key that takes precedence over the owner-editable endpoint, or
     * null when the shown URL is the one in effect without an override.
     */
    overriddenBy: z.string().nullable(),
  })
  .strict();
export type EndpointStatus = z.infer<typeof EndpointStatusSchema>;

export const ModelProviderStatusSchema = z
  .object({
    id: z.enum(MODEL_PROVIDER_IDS),
    label: z.string(),
    /** False when the provider's plugin package cannot be resolved. */
    pluginInstalled: z.boolean(),
    credential: CredentialStatusSchema,
    endpoint: EndpointStatusSchema.nullable(),
    supportsEndpoint: z.boolean(),
    /** True when `POST /api/model-settings/activate` accepts this provider. */
    activatable: z.boolean(),
    /** True when activation must name both model tiers. */
    requiresModelSelection: z.boolean(),
  })
  .strict();
export type ModelProviderStatusDto = z.infer<typeof ModelProviderStatusSchema>;

export const ActiveModelSourceSchema = z.enum([
  "user",
  "environment",
  "provider-default",
  "unknown",
]);

export const ActiveModelSchema = z
  .object({
    /**
     * A Models-page provider, or `other` when text runs through a provider
     * this page does not switch (for example DeepSeek or a subscription).
     */
    provider: z.union([z.enum(MODEL_PROVIDER_IDS), z.literal("other")]),
    /**
     * Display name of the text provider; null when no text provider is
     * configured (the client renders its own localized "not configured").
     */
    providerLabel: z.string().nullable(),
    /** `ELIZA_BRAIN_PROVIDER` on the live runtime; null when not pinned. */
    runtimeProviderName: z.string().nullable(),
    /** Effective small model id; null when no id can be determined. */
    smallModel: z.string().nullable(),
    largeModel: z.string().nullable(),
    /** Where each tier's id comes from; the tiers can differ. */
    smallModelSource: ActiveModelSourceSchema,
    largeModelSource: ActiveModelSourceSchema,
    endpoint: EndpointStatusSchema.nullable(),
    health: ProviderHealthSchema,
  })
  .strict();
export type ActiveModelDto = z.infer<typeof ActiveModelSchema>;

export const ModelSettingsOperationSchema = z
  .object({
    id: z.string(),
    provider: z.string(),
    state: z.enum(["pending", "applying", "succeeded", "failed"]),
    error: z.string().nullable(),
  })
  .strict();
export type ModelSettingsOperationDto = z.infer<
  typeof ModelSettingsOperationSchema
>;

export const ModelSettingsStatusSchema = z
  .object({
    active: ActiveModelSchema,
    providers: z.array(ModelProviderStatusSchema),
    /** Latest provider-switch operation, or null when none is retained. */
    operation: ModelSettingsOperationSchema.nullable(),
    /** True when Eliza Cloud manages this runtime; switching is read-only. */
    managedByCloud: z.boolean(),
  })
  .strict();
export type ModelSettingsStatusDto = z.infer<typeof ModelSettingsStatusSchema>;

const ModelIdSchema = z
  .string()
  .trim()
  .min(1, "Model id must not be empty")
  .max(MODEL_ID_MAX_LENGTH, "Model id is too long");

export const PostActivateModelRequestSchema = z
  .object({
    provider: z.enum(ACTIVATABLE_MODEL_PROVIDER_IDS),
    smallModel: ModelIdSchema.optional(),
    largeModel: ModelIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!providerRequiresModelSelection(value.provider)) return;
    for (const tier of ["smallModel", "largeModel"] as const) {
      if (value[tier] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [tier],
          message: `${value.provider} has no default models; choose ${tier} from its catalog.`,
          params: { reason: "MODEL_REQUIRED" },
        });
      }
    }
  });
export type PostActivateModelRequest = z.infer<
  typeof PostActivateModelRequestSchema
>;

export const PostActivateModelResponseSchema = z
  .object({
    operationId: z.string(),
    provider: z.enum(ACTIVATABLE_MODEL_PROVIDER_IDS),
    deduped: z.boolean(),
  })
  .strict();
export type PostActivateModelResponse = z.infer<
  typeof PostActivateModelResponseSchema
>;

export const ProviderModelOptionSchema = z
  .object({ id: z.string(), label: z.string() })
  .strict();
export type ProviderModelOption = z.infer<typeof ProviderModelOptionSchema>;

export const ProviderModelCatalogSchema = z.discriminatedUnion("state", [
  z
    .object({
      provider: z.enum(MODEL_PROVIDER_IDS),
      state: z.literal("ok"),
      models: z.array(ProviderModelOptionSchema).min(1),
      fetchedAt: z.string(),
    })
    .strict(),
  z
    .object({
      provider: z.enum(MODEL_PROVIDER_IDS),
      state: z.literal("no-models"),
      fetchedAt: z.string(),
    })
    .strict(),
  z
    .object({
      provider: z.enum(MODEL_PROVIDER_IDS),
      state: z.enum(["unreachable", "auth-failed"]),
      detail: z.string(),
      fetchedAt: z.string(),
    })
    .strict(),
  z
    .object({
      provider: z.enum(MODEL_PROVIDER_IDS),
      state: z.literal("missing-credential"),
    })
    .strict(),
  z
    .object({
      provider: z.enum(MODEL_PROVIDER_IDS),
      /** The provider's models are managed elsewhere (on-device catalog). */
      state: z.literal("not-listable"),
    })
    .strict(),
]);
export type ProviderModelCatalogDto = z.infer<
  typeof ProviderModelCatalogSchema
>;
