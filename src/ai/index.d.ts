// Types for the multi-model fallback router, so TypeScript projects can use the JS template as is:
//   import { createRouterFromEnv } from './ai/index.js';

export type ErrorKind =
  | 'rate_limit'
  | 'quota'
  | 'overloaded'
  | 'timeout'
  | 'network'
  | 'auth'
  | 'not_found'
  | 'bad_request'
  | 'bad_output'
  | 'aborted';

export const ERROR_KINDS: { readonly [K in ErrorKind]: K };

export interface Attempt {
  target: string;
  ok: boolean;
  ms: number;
  kind?: ErrorKind;
  error?: string;
}

export class AIError extends Error {
  kind: ErrorKind;
  status?: number;
  retryAfterMs?: number;
  provider?: string;
  model?: string;
  /** Set on the final error thrown by `generate` when every model failed. */
  attempts?: Attempt[];
  constructor(
    message: string,
    opts?: { kind?: ErrorKind; status?: number; retryAfterMs?: number; provider?: string; model?: string; cause?: unknown },
  );
}

export function kindFromStatus(status: number, bodyText?: string): ErrorKind;
export function parseRetryAfter(headerValue: string | null | undefined, body?: unknown, now?: number): number | undefined;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface CompleteRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Extra fields given to `generate` (e.g. `audio`) are passed through to the provider. */
  [extra: string]: unknown;
}

export interface CompleteResult {
  text: string;
  usage?: Usage;
  [extra: string]: unknown;
}

export interface Provider {
  name?: string;
  configured: boolean;
  disabledReason?: string;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

export type Providers = Record<string, Provider>;

export interface ChainEntry {
  provider: string;
  model: string;
  id?: string;
  timeoutMs?: number;
}

export interface GenerateRequest<T> {
  system?: string;
  messages: ChatMessage[];
  json?: boolean;
  temperature?: number;
  /** Use >= 1024: newer Gemini models spend tokens on thinking. */
  maxTokens?: number;
  /** Throwing here makes the router try the next model. */
  parse?: (text: string) => T;
  timeoutMs?: number;
  totalBudgetMs?: number;
  hedgeAfterMs?: number;
  signal?: AbortSignal;
  /** Pin one target id, e.g. "gemini:gemini-3.6-flash" (health checks). */
  only?: string;
  [extra: string]: unknown;
}

export interface GenerateResult<T> extends CompleteResult {
  data: T;
  provider: string;
  model: string;
  target: string;
  ms: number;
  attempts: Attempt[];
  totalMs: number;
}

export interface TargetStatus {
  id: string;
  provider: string;
  model: string;
  enabled: boolean;
  disabledReason: string | null;
  state: 'ready' | 'cooling' | 'disabled';
  coolingForMs: number;
  lastErrorKind: ErrorKind | 'slow' | null;
  lastError: string | null;
  successes: number;
  failures: number;
  avgMs: number | null;
}

export interface RouterEvent {
  type: 'attempt' | 'success' | 'failure' | 'cancelled' | 'skip' | 'hedge' | 'exhausted';
  at: number;
  target?: string;
  targets?: string[];
  kind?: ErrorKind;
  status?: number;
  message?: string;
  ms?: number;
  cooldownMs?: number;
  reason?: string;
  until?: number;
  attempts?: Attempt[];
}

export interface LLMRouter {
  generate<T = undefined>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
  status(): TargetStatus[];
  readonly enabledCount: number;
  /** Clear all cooldowns (e.g. after fixing a key). */
  reset(): void;
}

export interface RouterOptions {
  chain: ChainEntry[];
  providers: Providers;
  timeoutMs?: number;
  totalBudgetMs?: number;
  hedgeAfterMs?: number;
  cooldowns?: Partial<Record<ErrorKind | 'slow', number>>;
  maxCooldownMs?: number;
  lastChance?: boolean;
  now?: () => number;
  onEvent?: (event: RouterEvent) => void;
}

export function createLLMRouter(options: RouterOptions): LLMRouter;

export function createGeminiProvider(opts?: { apiKey?: string; baseURL?: string; fetchImpl?: typeof fetch }): Provider;

export function createOpenAICompatibleProvider(opts: {
  name: string;
  baseURL: string;
  apiKey?: string;
  headers?: Record<string, string>;
  requiresKey?: boolean;
  jsonMode?: boolean;
  fetchImpl?: typeof fetch;
}): Provider;

export const PRESETS: Record<'nvidia' | 'openrouter' | 'groq' | 'ollama', { baseURL: string; keyEnv: string | null; baseEnv?: string }>;

export type Env = Record<string, string | undefined>;

export const DEFAULT_CHAIN: string[];
export function parseChain(spec: string | string[]): ChainEntry[];
export function createProvidersFromEnv(env?: Env, opts?: { fetchImpl?: typeof fetch }): Providers;
export function simulateOutage(providers: Providers, names?: string[]): Providers;
export function createRouterFromEnv(
  env?: Env,
  opts?: { fetchImpl?: typeof fetch; onEvent?: (event: RouterEvent) => void; simulate?: string[]; providers?: Providers },
): LLMRouter;
