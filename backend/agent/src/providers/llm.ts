import Anthropic from '@anthropic-ai/sdk';
import { secrets } from '../env.js';
import { UpstreamError, errMsg } from '../util.js';

export const anthropic = new Anthropic({ apiKey: secrets.anthropic || undefined, maxRetries: 2 });

/** USD per million tokens, first-party API rates. Unknown models price at the most expensive row, never at zero. */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 }
};
const EMBED_USD_PER_MTOK = 0.02;
/** Tavily pay-as-you-go credit; a cached search is free. */
export const SEARCH_USD_PER_CALL = 0.008;

export function llmCost(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICES[model] ?? { in: 10, out: 50 };
  return (tokensIn * p.in + tokensOut * p.out) / 1e6;
}
export const embedCost = (tokens: number) => (tokens * EMBED_USD_PER_MTOK) / 1e6;

/** Thinking off on the latency-critical paths: the models that accept it get it disabled explicitly. */
const noThinking = (model: string) =>
  model.startsWith('claude-sonnet-5') || model.startsWith('claude-opus') ? { thinking: { type: 'disabled' as const } } : {};

export interface Usage {
  in: number;
  out: number;
}

/**
 * Stream a completion. `onText` gets every delta. A provider exception is rethrown as an
 * UpstreamError: there is no fallback text, ever.
 */
export async function streamText(opts: {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  signal?: AbortSignal;
  onText: (t: string) => void;
}): Promise<{ text: string; usage: Usage; stopReason: string | null }> {
  try {
    const stream = anthropic.messages.stream(
      {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: opts.messages,
        ...noThinking(opts.model)
      },
      { signal: opts.signal }
    );
    stream.on('text', (t) => opts.onText(t));
    const msg = await stream.finalMessage();
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { text, usage: { in: msg.usage.input_tokens, out: msg.usage.output_tokens }, stopReason: msg.stop_reason };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new UpstreamError(`LLM ${opts.model}: ${errMsg(e)}`);
  }
}

/** One plain completion (the planner's compact line format). Throws UpstreamError on failure. */
export async function textCall(opts: { model: string; system: string; user: string; maxTokens: number; signal?: AbortSignal }): Promise<{ text: string; usage: Usage }> {
  try {
    const msg = await anthropic.messages.create(
      { model: opts.model, max_tokens: opts.maxTokens, system: opts.system, messages: [{ role: 'user', content: opts.user }], ...noThinking(opts.model) },
      { signal: opts.signal }
    );
    return { text: msg.content.map((b) => (b.type === 'text' ? b.text : '')).join(''), usage: { in: msg.usage.input_tokens, out: msg.usage.output_tokens } };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new UpstreamError(`LLM ${opts.model}: ${errMsg(e)}`);
  }
}

/** One structured JSON call (memory extraction). Parsed with JSON.parse, validated by the caller. */
export async function jsonCall(opts: {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<{ data: unknown; usage: Usage }> {
  try {
    const msg = await anthropic.messages.create(
      {
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: 'user', content: opts.user }],
        output_config: { format: { type: 'json_schema', schema: opts.schema } },
        ...noThinking(opts.model)
      },
      { signal: opts.signal }
    );
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { data: JSON.parse(text), usage: { in: msg.usage.input_tokens, out: msg.usage.output_tokens } };
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new UpstreamError(`LLM ${opts.model}: ${errMsg(e)}`);
  }
}
