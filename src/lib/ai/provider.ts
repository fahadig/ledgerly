/**
 * Provider abstraction for the LLM half of the assistant.
 *
 * The whole point of this file is that swapping models is a config change,
 * not a code change. Set AI_PROVIDER to ollama | anthropic | openai | none.
 * Locally you run Ollama; in the cloud you flip one env var.
 */

export type Role = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: Role;
  content: string;
}

export interface CompleteOptions {
  /** Ask the model for strict JSON. Providers enforce this differently. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
}

export interface LLMProvider {
  name: string;
  model: string;
  available(): Promise<boolean>;
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<CompletionResult>;
}

const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS ?? 120_000);

function withTimeout(signal?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  signal?.addEventListener('abort', () => ctrl.abort());
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

// ─────────────────────────── Ollama (default, local) ─────────────────

class OllamaProvider implements LLMProvider {
  name = 'ollama';
  model = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct';
  private url = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');

  async available() {
    try {
      const res = await fetch(`${this.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<CompletionResult> {
    const started = Date.now();
    const { signal, done } = withTimeout(opts.signal);
    try {
      const res = await fetch(`${this.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          ...(opts.json ? { format: 'json' } : {}),
          options: {
            temperature: opts.temperature ?? 0.1,
            num_predict: opts.maxTokens ?? 1024,
          },
        }),
      });
      if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { message?: { content?: string } };
      return {
        text: data.message?.content ?? '',
        provider: this.name,
        model: this.model,
        latencyMs: Date.now() - started,
      };
    } finally {
      done();
    }
  }
}

// ─────────────────────────── Anthropic ───────────────────────────────

class AnthropicProvider implements LLMProvider {
  name = 'anthropic';
  model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  private key = process.env.ANTHROPIC_API_KEY || '';

  async available() {
    return Boolean(this.key);
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<CompletionResult> {
    const started = Date.now();
    const { signal, done } = withTimeout(opts.signal);
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const rest = messages.filter((m) => m.role !== 'system');
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.key,
          'anthropic-version': '2023-06-01',
        },
        signal,
        body: JSON.stringify({
          model: this.model,
          max_tokens: opts.maxTokens ?? 2048,
          temperature: opts.temperature ?? 0.1,
          ...(system ? { system } : {}),
          messages: rest.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      return { text, provider: this.name, model: this.model, latencyMs: Date.now() - started };
    } finally {
      done();
    }
  }
}

// ─────────────────────────── OpenAI ──────────────────────────────────

class OpenAIProvider implements LLMProvider {
  name = 'openai';
  model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  private key = process.env.OPENAI_API_KEY || '';
  private base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

  async available() {
    return Boolean(this.key);
  }

  async complete(messages: ChatMessage[], opts: CompleteOptions = {}): Promise<CompletionResult> {
    const started = Date.now();
    const { signal, done } = withTimeout(opts.signal);
    try {
      const res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
        signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: opts.temperature ?? 0.1,
          max_tokens: opts.maxTokens ?? 2048,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        provider: this.name,
        model: this.model,
        latencyMs: Date.now() - started,
      };
    } finally {
      done();
    }
  }
}

// ─────────────────────────── Null provider ───────────────────────────

class NoProvider implements LLMProvider {
  name = 'none';
  model = 'none';
  async available() {
    return false;
  }
  async complete(): Promise<CompletionResult> {
    throw new Error('No LLM provider configured. Set AI_PROVIDER in .env.');
  }
}

let cached: LLMProvider | null = null;

export function getProvider(): LLMProvider {
  if (cached) return cached;
  switch ((process.env.AI_PROVIDER || 'ollama').toLowerCase()) {
    case 'anthropic':
      cached = new AnthropicProvider();
      break;
    case 'openai':
      cached = new OpenAIProvider();
      break;
    case 'none':
      cached = new NoProvider();
      break;
    default:
      cached = new OllamaProvider();
  }
  return cached;
}

/** Pull the first JSON object out of a model response, tolerating fences. */
export function extractJson<T = unknown>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
