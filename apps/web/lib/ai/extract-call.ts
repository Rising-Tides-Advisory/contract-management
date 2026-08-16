/**
 * Provider dispatch for contract metadata extraction.
 *
 * Server-only. Both callers — the `contract.ai_extract` worker and the upload
 * wizard's background enrichment route — go through here so the request shape,
 * token budget and PDF handling stay identical between them.
 */

import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"

export type ExtractionProviderId = "anthropic" | "openai" | "ollama"

/**
 * What we send the model.
 *
 * `pdf` hands Anthropic the original file as a native document block, so the
 * model reads the real page images rather than our text extraction. That is the
 * only path that works on a scanned contract, and it is also the only way the
 * model can see true page boundaries.
 */
export type ExtractionContent =
  | { kind: "text"; text: string }
  | { kind: "pdf"; base64: string }

export interface ExtractionCallOptions {
  provider: ExtractionProviderId
  apiKey: string | null
  model: string
  systemPrompt: string
  content: ExtractionContent
  /** Base URL for Ollama; ignored by the cloud providers. */
  ollamaBaseUrl?: string
}

/**
 * Models that run adaptive thinking unless told otherwise. On these,
 * `max_tokens` caps thinking *and* the visible response together, so a budget
 * sized for the JSON alone truncates the answer mid-object.
 */
const THINKS_BY_DEFAULT_RE = /^claude-(?:opus-5|sonnet-5|fable-5|mythos-5)/

/**
 * Newer Anthropic models reject `temperature`/`top_p`/`top_k` outright
 * (400 on Opus 5, and on Sonnet 5 for any non-default value). The extraction
 * call used to pass `temperature: 0` unconditionally, which meant every org
 * that picked Sonnet 5 or Opus 5 in the model picker got a hard failure on
 * every extraction. Steer determinism through the prompt instead.
 */
const REJECTS_SAMPLING_PARAMS_RE = /^claude-(?:opus-[5-9]|sonnet-[5-9]|fable-|mythos-|opus-4-[78])/

export function extractionMaxTokens(model: string): number {
  return THINKS_BY_DEFAULT_RE.test(model) ? 16_000 : 2_048
}

/** Anthropic's request ceiling is 32 MB; base64 inflates a payload by ~4/3. */
export const NATIVE_PDF_MAX_BYTES = 20 * 1024 * 1024

/** Only Anthropic accepts a PDF as a native document block. */
export function supportsNativePdf(provider: ExtractionProviderId): boolean {
  return provider === "anthropic"
}

let _anthropic: Anthropic | null = null
let _anthropicKey: string | null = null
function getAnthropic(apiKey: string): Anthropic {
  if (!_anthropic || _anthropicKey !== apiKey) {
    _anthropic = new Anthropic({ apiKey })
    _anthropicKey = apiKey
  }
  return _anthropic
}

let _openai: OpenAI | null = null
let _openaiKey: string | null = null
function getOpenAI(apiKey: string): OpenAI {
  if (!_openai || _openaiKey !== apiKey) {
    _openai = new OpenAI({ apiKey })
    _openaiKey = apiKey
  }
  return _openai
}

const USER_PREAMBLE = "Here is the contract to analyze:"

/**
 * Run one extraction call and return the raw model text.
 *
 * Throws on transport or provider errors; callers decide whether that is fatal
 * or retryable.
 */
export async function callExtractionModel(opts: ExtractionCallOptions): Promise<string> {
  const { provider, apiKey, model, systemPrompt, content } = opts

  if (provider === "anthropic") {
    if (!apiKey) throw new Error("anthropic_api_key_missing")

    const userContent: Anthropic.ContentBlockParam[] =
      content.kind === "pdf"
        ? [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: content.base64 },
            },
            { type: "text", text: USER_PREAMBLE },
          ]
        : [{ type: "text", text: `${USER_PREAMBLE}\n\n${content.text}` }]

    const msg = await getAnthropic(apiKey).messages.create({
      model,
      max_tokens: extractionMaxTokens(model),
      // See REJECTS_SAMPLING_PARAMS_RE — omitted entirely on models that 400 on it.
      ...(REJECTS_SAMPLING_PARAMS_RE.test(model) ? {} : { temperature: 0 }),
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    })

    const block = msg.content.find((b) => b.type === "text")
    return block?.type === "text" ? block.text.trim() : ""
  }

  if (content.kind === "pdf") {
    // Callers must check supportsNativePdf() before building a pdf payload.
    throw new Error(`native_pdf_unsupported_for_${provider}`)
  }

  if (provider === "openai") {
    if (!apiKey) throw new Error("openai_api_key_missing")
    const res = await getOpenAI(apiKey).chat.completions.create({
      model,
      max_tokens: extractionMaxTokens(model),
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${USER_PREAMBLE}\n\n${content.text}` },
      ],
    })
    return res.choices[0]?.message.content?.trim() ?? ""
  }

  if (provider === "ollama") {
    const base = (opts.ollamaBaseUrl ?? "http://localhost:11434").replace(/\/$/, "")
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `${USER_PREAMBLE}\n\n${content.text}` },
        ],
      }),
    })
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`)
    const data = (await res.json()) as { message?: { content?: string } }
    return data.message?.content?.trim() ?? ""
  }

  throw new Error(`unknown_provider_${provider}`)
}
