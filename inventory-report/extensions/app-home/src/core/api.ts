import {DataError} from './domain.ts';
import {ANALYTICS} from './queries.ts';
import type {Cell, GraphqlClient, GraphqlResult, QlRow} from './types.ts';

type Table = {columns: {name: string; dataType?: string}[]; rows: unknown};
type AnalyticsPayload = {shopifyqlQuery?: {parseErrors?: string[]; tableData?: Table | null} | null};
export type RetryNotice = (delayMs: number, retry: number) => void;
export type RatePolicy = {minIntervalMs: number; retryBaseMs: number; jitter: number};
export function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
}
export function isAborted(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError'; }
export function message(error: unknown): string { return error instanceof Error ? error.message : typeof error === 'string' ? error : typeof record(error)?.message === 'string' ? String(record(error)!.message) : 'The report could not be loaded.'; }

export function normalize(table: Table, required: string[], context = 'Analytics'): QlRow[] {
  if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) throw new DataError(`${context}: analytics did not return a valid table.`);
  const names = table.columns.map(c => c?.name);
  if (names.some(name => typeof name !== 'string' || name.length === 0)) throw new DataError(`${context}: analytics returned an invalid column definition.`);
  if (new Set(names).size !== names.length) throw new DataError(`${context}: duplicate column names were returned: ${names.join(', ')}.`);
  if (table.rows.length === 0) return [];
  const missing = required.filter(name => !names.includes(name));
  if (missing.length > 0) throw new DataError(`${context}: required columns missing: ${missing.join(', ')}. Returned columns: ${names.join(', ') || '(none)'}. Returned rows: ${table.rows.length}. No reconciliation was calculated.`);
  return table.rows.map(entry => {
    if (entry === null || typeof entry !== 'object') throw new DataError('Analytics returned an invalid row.');
    if (Array.isArray(entry) && entry.length !== names.length) throw new DataError('Analytics returned an incomplete row.');
    const row: QlRow = {};
    names.forEach((name, i) => {
      const cell: unknown = Array.isArray(entry) ? entry[i] : (entry as Record<string, unknown>)[name];
      if (cell === undefined || (cell !== null && typeof cell !== 'string' && typeof cell !== 'number')) throw new DataError('Analytics returned an unsupported cell value.');
      row[name] = cell as Cell;
    });
    return row;
  });
}

function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null; }
export function isRateLimited(error: unknown): boolean {
  const obj = record(error);
  const code = String(record(obj?.extensions)?.code ?? obj?.code ?? '').toUpperCase();
  if (['THROTTLED', 'RATE_LIMITED', 'RATE_LIMIT_EXCEEDED', 'TOO_MANY_REQUESTS'].includes(code)) return true;
  if (Number(obj?.status ?? obj?.statusCode ?? record(obj?.response)?.status) === 429) return true;
  const text = typeof error === 'string' ? error : String(obj?.message ?? '');
  return /\brate[\s_-]*limit(?:ed|ing| exceeded)?\b|\btoo many requests\b|\bthrottl(?:ed|ing)\b/i.test(text);
}
export function retryAfterMs(error: unknown, now = Date.now()): number {
  const obj = record(error), headers = obj?.headers ?? record(obj?.response)?.headers;
  const h = record(headers);
  const value = h && typeof h.get === 'function' ? (h.get as (key: string) => unknown).call(headers, 'retry-after') : h?.['retry-after'] ?? h?.['Retry-After'];
  if (value == null) return 0;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException('Request cancelled.', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, {once: true});
  });
}

/** One in-flight host call, paced across context, reports, details and retries. */
export class Api {
  private running = false;
  private waiters: (() => void)[] = [];
  private nextStart = 0;
  private client: GraphqlClient;
  private timeoutMs: number;
  private policy: RatePolicy;
  constructor(client: GraphqlClient, timeoutMs = 30_000, policy: Partial<RatePolicy> = {}) {
    this.client = client; this.timeoutMs = timeoutMs;
    this.policy = {minIntervalMs: 300, retryBaseMs: 1500, jitter: 0.2, ...policy};
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    if (!this.running) { this.running = true; return; }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const ready = () => { cleanup(); resolve(); };
      const remove = () => { this.waiters = this.waiters.filter(w => w !== ready); cleanup(); };
      const cancel = () => { remove(); reject(new DOMException('Request cancelled.', 'AbortError')); };
      const timer = setTimeout(() => { remove(); reject(new Error('Previous Shopify requests are still running. Wait briefly or reload the app.')); }, this.timeoutMs);
      this.waiters.push(ready);
      signal?.addEventListener('abort', cancel, {once: true});
    });
  }
  private release(): void { const next = this.waiters.shift(); if (next) next(); else this.running = false; }
  private async once<T>(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<GraphqlResult<T>> {
    await this.acquire(signal);
    try {
      // Recheck after sleeping: another rate-limit response can extend the cooldown.
      while (this.nextStart > Date.now()) await sleep(this.nextStart - Date.now(), signal);
      abortIfNeeded(signal);
    } catch (error) { this.release(); throw error; }
    this.nextStart = Date.now() + this.policy.minIntervalMs;
    const request = Promise.resolve().then(() => this.client<T>(query, {variables}));
    // The platform call is not cancellable. Keep its slot until it really settles.
    void request.then(() => this.release(), () => this.release());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Shopify did not respond in time. Narrow the period or location and retry. No partial result was used.')), this.timeoutMs);
      cancel = () => reject(new DOMException('Request cancelled.', 'AbortError'));
      signal?.addEventListener('abort', cancel, {once: true});
      if (signal?.aborted) cancel();
    });
    try { return await Promise.race([request, deadline]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal, onRetry?: RetryNotice): Promise<T> {
    if (!/^\s*query\b/.test(query)) throw new DataError('This app only permits read-only GraphQL queries.');
    for (let attempt = 0; attempt < 4; attempt++) {
      abortIfNeeded(signal);
      try {
        const response = await this.once<T>(query, variables, signal);
        abortIfNeeded(signal);
        if (response.errors?.length) {
          if (response.errors.every(isRateLimited)) throw response.errors[0];
          throw new DataError(response.errors.map(e => e.message).join(' '));
        }
        if (!response.data) throw new DataError('Shopify returned no data. Check the app’s read permissions.');
        if (query === ANALYTICS) {
          const errors = (response.data as AnalyticsPayload).shopifyqlQuery?.parseErrors;
          if (errors?.length && errors.every(isRateLimited)) throw new Error(errors.join(' '));
        }
        return response.data;
      } catch (error) {
        if (isAborted(error) || error instanceof DataError || !isRateLimited(error)) throw error;
        const requestedDelay = retryAfterMs(error);
        const backoff = this.policy.retryBaseMs * 2 ** attempt;
        const delay = Math.max(requestedDelay, Math.ceil(backoff * (1 + Math.random() * this.policy.jitter)));
        // The cooldown also applies to a subsequent manual Run, even when this
        // operation exhausts its retry budget. Never retry ahead of Retry-After.
        this.nextStart = Math.max(this.nextStart, Date.now() + delay);
        if (attempt === 3 || requestedDelay > 60_000) throw new DataError(`Shopify is still rate limiting this request. Wait at least ${Math.ceil(delay / 1000)}s before retrying. No partial report was used.`);
        onRetry?.(delay, attempt + 1);
        await sleep(delay, signal);
      }
    }
    throw new DataError('Shopify is rate limiting requests.');
  }

  async ql(query: string, required: string[], signal?: AbortSignal, onRetry?: RetryNotice): Promise<QlRow[]> {
    const source = query.match(/^FROM\s+([a-z_]+)/im)?.[1] ?? 'analytics';
    const stage = required.includes('inventory_adjustment_id') ? 'Movement detail'
      : required.includes('inventory_change_reason') ? 'Movement breakdown'
      : source === 'inventory_by_location' ? 'Opening/closing balances' : 'Analytics query';
    const context = `${stage} (${source})`;
    let data: AnalyticsPayload;
    try { data = await this.graphql<AnalyticsPayload>(ANALYTICS, {query}, signal, onRetry); }
    catch (error) { if (isAborted(error)) throw error; throw new DataError(`${context}: ${message(error)}`); }
    const payload = data.shopifyqlQuery;
    if (payload?.parseErrors?.length) throw new DataError(`${context}: ${payload.parseErrors.join(' ')}`);
    if (!payload?.tableData) throw new DataError(`${context}: analytics returned no table. This is not proof of zero movements.`);
    return normalize(payload.tableData, required, context);
  }
}
