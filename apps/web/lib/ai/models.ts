/**
 * The model catalog — one place, so every caller agrees.
 *
 * Before this file, each route that called an AI provider carried its own
 * `aiConfig.model ?? "..."` fallback, and they had drifted apart: the risk-score
 * route defaulted Anthropic to `claude-3-5-haiku-latest` (retired) and Ollama to
 * `llama3.1`, while every other route used `claude-haiku-4-5` and `llama3`. An
 * org with its own API key but no model set would therefore get a 404 from
 * Anthropic on risk scoring and work fine everywhere else.
 *
 * Two rules:
 *   - Routes call `defaultModelFor(provider)`, never a string literal.
 *   - The picker lists come from `MODEL_OPTIONS`, so the UI cannot offer a model
 *     the server would not accept.
 *
 * This module is pure data and safe to import from client components.
 */

export type AiProviderId = "anthropic" | "openai" | "ollama"

export interface ModelOption {
  value: string
  label: string
  /** Shown under the label in the picker — the cost/capability trade-off. */
  hint: string
}

/**
 * Selectable models per cloud provider, cheapest first.
 *
 * Ollama is deliberately absent: self-hosted installs run whatever they have
 * pulled locally, so its model is a free-text field.
 */
export const MODEL_OPTIONS: Record<"anthropic" | "openai", ModelOption[]> = {
  anthropic: [
    {
      value: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      hint: "Fastest and cheapest — good for extraction and search",
    },
    {
      value: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      hint: "Balanced — better reasoning on dense contracts",
    },
    {
      value: "claude-opus-5",
      label: "Claude Opus 5",
      hint: "Most capable — highest cost per contract",
    },
  ],
  openai: [
    {
      value: "gpt-4o-mini",
      label: "GPT-4o mini",
      hint: "Fastest and cheapest",
    },
    {
      value: "gpt-4o",
      label: "GPT-4o",
      hint: "Balanced",
    },
    {
      value: "gpt-4-turbo",
      label: "GPT-4 Turbo",
      hint: "Higher cost per contract",
    },
  ],
}

/**
 * What to use when neither the org nor the environment names a model.
 *
 * Deliberately the cheapest option for each provider: an org that never opened
 * the model picker should not be billed at Opus rates by surprise.
 */
export const DEFAULT_MODEL: Record<AiProviderId, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  ollama: "llama3",
}

export function defaultModelFor(provider: AiProviderId): string {
  return DEFAULT_MODEL[provider]
}

/**
 * True when the model is one this build offers for the provider.
 *
 * Used to decide whether the picker can show a stored value as a selected
 * option or has to render it as a custom entry — an org that set its model
 * through the API, or before a model was retired from the list, keeps working.
 */
export function isKnownModel(provider: AiProviderId, model: string): boolean {
  if (provider === "ollama") return false
  return MODEL_OPTIONS[provider].some((m) => m.value === model)
}
