let _idCounter = 0;
function nextId() { return `tc_${++_idCounter}`; }

// ── Shared types ─────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string; default?: unknown; nullable?: boolean }>;
    required: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result: unknown };

export interface LLMMessage {
  role: 'user' | 'assistant';
  parts: MessagePart[];
}

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface GenerateResult {
  text?: string;
  toolCalls?: ToolCall[];
  tokensUsed: number;
}

export interface LLMProvider {
  generate(
    messages: LLMMessage[],
    systemPrompt: string,
    options?: GenerateOptions,
  ): Promise<{ text: string; tokensUsed: number }>;

  generateWithTools(
    messages: LLMMessage[],
    systemPrompt: string,
    tools: ToolDef[],
    options?: GenerateOptions,
  ): Promise<GenerateResult>;
}

// ── Gemini ────────────────────────────────────────────────────────────────────

function toGeminiMessages(messages: LLMMessage[]): unknown[] {
  return messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: msg.parts.map(p => {
      if (p.type === 'text') return { text: p.text };
      if (p.type === 'tool_call') return { functionCall: { name: p.name, args: p.args } };
      if (p.type === 'tool_result') return { functionResponse: { name: p.name, response: p.result } };
    }),
  }));
}

class GeminiProvider implements LLMProvider {
  private readonly url: string;

  constructor(private readonly apiKey: string, model = 'gemini-2.5-flash') {
    this.url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  }

  private async call(body: unknown): Promise<any> {
    const res = await fetch(`${this.url}?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async generate(messages: LLMMessage[], systemPrompt: string, options: GenerateOptions = {}): Promise<{ text: string; tokensUsed: number }> {
    const data = await this.call({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: toGeminiMessages(messages),
      generationConfig: { temperature: options.temperature ?? 0.5, maxOutputTokens: options.maxTokens ?? 8192 },
    });
    return {
      text: data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '(no response)',
      tokensUsed: data?.usageMetadata?.totalTokenCount ?? 0,
    };
  }

  async generateWithTools(messages: LLMMessage[], systemPrompt: string, tools: ToolDef[], options: GenerateOptions = {}): Promise<GenerateResult> {
    const data = await this.call({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: toGeminiMessages(messages),
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: { temperature: options.temperature ?? 0.3, maxOutputTokens: options.maxTokens ?? 2048 },
    });
    const candidate = data?.candidates?.[0];
    const tokensUsed = (data?.usageMetadata?.totalTokenCount ?? 0) as number;
    const text = candidate?.content?.parts?.find((p: any) => p.text)?.text as string | undefined;
    const toolCalls: ToolCall[] = (candidate?.content?.parts ?? [])
      .filter((p: any) => p.functionCall)
      .map((p: any) => ({ id: nextId(), name: p.functionCall.name, args: p.functionCall.args ?? {} }));
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, tokensUsed };
  }
}

// ── Claude ────────────────────────────────────────────────────────────────────

function toClaudeMessages(messages: LLMMessage[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const textParts = msg.parts.filter(p => p.type === 'text') as Extract<MessagePart, { type: 'text' }>[];
      const resultParts = msg.parts.filter(p => p.type === 'tool_result') as Extract<MessagePart, { type: 'tool_result' }>[];
      if (resultParts.length) {
        result.push({
          role: 'user',
          content: resultParts.map(p => ({ type: 'tool_result', tool_use_id: p.id, content: JSON.stringify(p.result) })),
        });
      } else if (textParts.length) {
        result.push({ role: 'user', content: textParts[0].text });
      }
    } else {
      const content: unknown[] = [];
      for (const p of msg.parts) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text });
        if (p.type === 'tool_call') content.push({ type: 'tool_use', id: p.id, name: p.name, input: p.args });
      }
      result.push({ role: 'assistant', content });
    }
  }
  return result;
}

class ClaudeProvider implements LLMProvider {
  private readonly url = 'https://api.anthropic.com/v1/messages';

  constructor(private readonly apiKey: string, private readonly model = 'claude-sonnet-4-6') {}

  private async call(body: unknown): Promise<any> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Claude error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async generate(messages: LLMMessage[], systemPrompt: string, options: GenerateOptions = {}): Promise<{ text: string; tokensUsed: number }> {
    const data = await this.call({
      model: this.model,
      system: systemPrompt,
      messages: toClaudeMessages(messages),
      max_tokens: options.maxTokens ?? 8192,
      temperature: options.temperature ?? 0.5,
    });
    return {
      text: data?.content?.find((b: any) => b.type === 'text')?.text ?? '(no response)',
      tokensUsed: (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0),
    };
  }

  async generateWithTools(messages: LLMMessage[], systemPrompt: string, tools: ToolDef[], options: GenerateOptions = {}): Promise<GenerateResult> {
    const data = await this.call({
      model: this.model,
      system: systemPrompt,
      messages: toClaudeMessages(messages),
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      max_tokens: options.maxTokens ?? 2048,
      temperature: options.temperature ?? 0.3,
    });
    const tokensUsed = (data?.usage?.input_tokens ?? 0) + (data?.usage?.output_tokens ?? 0);
    const text = data?.content?.find((b: any) => b.type === 'text')?.text as string | undefined;
    const toolCalls: ToolCall[] = (data?.content ?? [])
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => ({ id: b.id, name: b.name, args: b.input ?? {} }));
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, tokensUsed };
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

function toOpenAIMessages(messages: LLMMessage[]): unknown[] {
  const result: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const textParts = msg.parts.filter(p => p.type === 'text') as Extract<MessagePart, { type: 'text' }>[];
      const resultParts = msg.parts.filter(p => p.type === 'tool_result') as Extract<MessagePart, { type: 'tool_result' }>[];
      if (textParts.length) result.push({ role: 'user', content: textParts[0].text });
      // Tool results are separate messages in OpenAI
      for (const p of resultParts) result.push({ role: 'tool', tool_call_id: p.id, content: JSON.stringify(p.result) });
    } else {
      const textPart = msg.parts.find(p => p.type === 'text') as Extract<MessagePart, { type: 'text' }> | undefined;
      const callParts = msg.parts.filter(p => p.type === 'tool_call') as Extract<MessagePart, { type: 'tool_call' }>[];
      result.push({
        role: 'assistant',
        content: textPart?.text ?? null,
        ...(callParts.length ? {
          tool_calls: callParts.map(p => ({
            id: p.id,
            type: 'function',
            function: { name: p.name, arguments: JSON.stringify(p.args) },
          })),
        } : {}),
      });
    }
  }
  return result;
}

class OpenAIProvider implements LLMProvider {
  private readonly url = 'https://api.openai.com/v1/chat/completions';

  constructor(private readonly apiKey: string, private readonly model = 'gpt-4o') {}

  private async call(body: unknown): Promise<any> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async generate(messages: LLMMessage[], systemPrompt: string, options: GenerateOptions = {}): Promise<{ text: string; tokensUsed: number }> {
    const data = await this.call({
      model: this.model,
      messages: [{ role: 'system', content: systemPrompt }, ...toOpenAIMessages(messages)],
      temperature: options.temperature ?? 0.5,
      max_tokens: options.maxTokens ?? 8192,
    });
    return {
      text: data?.choices?.[0]?.message?.content ?? '(no response)',
      tokensUsed: data?.usage?.total_tokens ?? 0,
    };
  }

  async generateWithTools(messages: LLMMessage[], systemPrompt: string, tools: ToolDef[], options: GenerateOptions = {}): Promise<GenerateResult> {
    const data = await this.call({
      model: this.model,
      messages: [{ role: 'system', content: systemPrompt }, ...toOpenAIMessages(messages)],
      tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: 'auto',
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048,
    });
    const msg = data?.choices?.[0]?.message;
    const tokensUsed = data?.usage?.total_tokens ?? 0;
    const text = (msg?.content as string | null) || undefined;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments ?? '{}'),
    }));
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, tokensUsed };
  }
}

// ── Groq ──────────────────────────────────────────────────────────────────────
// OpenAI-compatible API — reuses toOpenAIMessages and the same request shape.

class GroqProvider implements LLMProvider {
  private readonly url = 'https://api.groq.com/openai/v1/chat/completions';

  constructor(private readonly apiKey: string, private readonly model = 'llama-3.3-70b-versatile') {}

  private async call(body: unknown): Promise<any> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`Groq error ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async generate(messages: LLMMessage[], systemPrompt: string, options: GenerateOptions = {}): Promise<{ text: string; tokensUsed: number }> {
    const data = await this.call({
      model: this.model,
      messages: [{ role: 'system', content: systemPrompt }, ...toOpenAIMessages(messages)],
      temperature: options.temperature ?? 0.5,
      max_tokens: options.maxTokens ?? 8192,
    });
    return {
      text: data?.choices?.[0]?.message?.content ?? '(no response)',
      tokensUsed: data?.usage?.total_tokens ?? 0,
    };
  }

  async generateWithTools(messages: LLMMessage[], systemPrompt: string, tools: ToolDef[], options: GenerateOptions = {}): Promise<GenerateResult> {
    const data = await this.call({
      model: this.model,
      messages: [{ role: 'system', content: systemPrompt }, ...toOpenAIMessages(messages)],
      tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: 'auto',
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 2048,
    });
    const msg = data?.choices?.[0]?.message;
    const tokensUsed = data?.usage?.total_tokens ?? 0;
    const text = (msg?.content as string | null) || undefined;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc: any) => ({
      id: tc.id,
      name: tc.function.name,
      args: JSON.parse(tc.function.arguments ?? '{}'),
    }));
    return { text, toolCalls: toolCalls.length ? toolCalls : undefined, tokensUsed };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createLLMProvider(): LLMProvider {
  const providerName = process.env.LLM_PROVIDER ?? 'gemini';
  const apiKey = process.env.LLM_API_KEY ?? '';
  const modelOverride = process.env.LLM_MODEL || '';

  if (!apiKey) throw new Error(`LLM_API_KEY not set (LLM_PROVIDER=${providerName})`);

  switch (providerName) {
    case 'gemini':  return new GeminiProvider(apiKey, modelOverride || 'gemini-2.5-flash');
    case 'claude':  return new ClaudeProvider(apiKey, modelOverride || 'claude-sonnet-4-6');
    case 'openai':  return new OpenAIProvider(apiKey, modelOverride || 'gpt-4o');
    case 'groq':    return new GroqProvider(apiKey, modelOverride || 'llama-3.3-70b-versatile');
    default:
      throw new Error(`Unknown LLM_PROVIDER: "${providerName}". Valid values: gemini, claude, openai, groq`);
  }
}

export function isLLMConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

// Makes the cheapest possible call to verify the key is accepted.
// Returns null on success, or an error message string on failure.
export async function validateLLMKey(provider: string, apiKey: string): Promise<string | null> {
  try {
    let res: Response;
    switch (provider) {
      case 'gemini':
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        break;
      case 'claude':
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          signal: AbortSignal.timeout(10_000),
        });
        break;
      case 'openai':
        res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(10_000),
        });
        break;
      case 'groq':
        res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
          signal: AbortSignal.timeout(10_000),
        });
        break;
      default:
        return `Unknown provider: ${provider}`;
    }

    if (res.ok) return null;

    // Parse error body for a useful message
    const body = await res.json().catch(() => ({})) as any;
    const detail = body?.error?.message ?? body?.message ?? `HTTP ${res.status}`;
    if (res.status === 400 && provider === 'gemini' && detail.includes('API key')) return 'Invalid API key';
    if (res.status === 401 || res.status === 403) return `Invalid API key (${res.status})`;
    // 400 on Gemini with a real key can mean model/quota issues — treat as valid key
    if (res.status === 400) return null;
    return `${provider} API error: ${detail}`;
  } catch (e: any) {
    if (e.name === 'TimeoutError') return 'Validation timed out — check your network connection';
    return e.message;
  }
}
