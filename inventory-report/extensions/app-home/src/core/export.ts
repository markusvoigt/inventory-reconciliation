import {abortIfNeeded} from './api.ts';
import {add, assertOrdered, DataError, id, key, sameFilters, validateFilters} from './domain.ts';
import {csvHeader, csvRow, pageCsv} from './csv.ts';
import type {Context, Filters, Page, Pair} from './types.ts';

export const CSV_DATA_PREFIX = 'data:text/csv;charset=utf-8,';
// Application guardrails, NOT claimed Shopify or browser platform limits.
export type ExportLimits = {maxRows: number; maxEncodedBytes: number; maxPages: number; maxWorkMs: number};
export const EXPORT_LIMITS: Readonly<ExportLimits> = Object.freeze({maxRows: 5000, maxEncodedBytes: 2 * 1024 * 1024, maxPages: 100, maxWorkMs: 4 * 60 * 1000});
export type ExportCheckpoint = {
  version: 1; exportId: string; shopId: string; filters: Filters; startedAt: string;
  nextPart: number; after: Pair | null; completedRows: number;
};
export type CheckpointStore = {
  load(shopId: string): Promise<unknown>;
  save(checkpoint: ExportCheckpoint): Promise<void>;
  clear(shopId: string): Promise<void>;
};
export type ExportProgress = {rows: number; pages: number; csvBytes: number; encodedBytes: number};
export type CsvPart = ExportProgress & {
  uri: string; filename: string; filters: Filters; exportId: string; part: number;
  completedRowsBefore: number; hasMore: boolean; next: ExportCheckpoint | null;
  missingBalances: number; variances: number; scope: 'page' | 'selection';
};
export type ExportReader = (after: Pair | null, signal?: AbortSignal) => Promise<Page>;

export function createExport(context: Context, filters: Filters, now = new Date()): ExportCheckpoint {
  const error = validateFilters(filters, now);
  if (error) throw new DataError(error);
  if (filters.timezone !== context.timezone) throw new DataError('Export timezone does not match the store.');
  return {version: 1, exportId: now.getTime().toString(36) + '-' + Math.random().toString(36).slice(2, 8), shopId: context.shopId, filters: {...filters}, startedAt: now.toISOString(), nextPart: 1, after: null, completedRows: 0};
}
export function parseCheckpoint(value: unknown, context: Context): ExportCheckpoint | null {
  if (value == null) return null;
  if (typeof value !== 'object') throw new DataError('Saved export progress is invalid. Discard it and start again.');
  const v = value as Record<string, unknown>;
  const f = v.filters as Record<string, unknown> | undefined;
  if (v.version !== 1 || v.shopId !== context.shopId || typeof v.exportId !== 'string' || !/^[a-z0-9-]{6,64}$/.test(v.exportId)
    || typeof v.startedAt !== 'string' || !Number.isFinite(Date.parse(v.startedAt))
    || !Number.isSafeInteger(v.nextPart) || Number(v.nextPart) < 1
    || !Number.isSafeInteger(v.completedRows) || Number(v.completedRows) < 0
    || !f || typeof f.start !== 'string' || typeof f.end !== 'string' || typeof f.sku !== 'string' || typeof f.timezone !== 'string'
    || !(f.locationId === null || typeof f.locationId === 'string')) throw new DataError('Saved export progress is invalid or belongs to a different store.');
  const filters: Filters = {start: f.start, end: f.end, sku: f.sku, timezone: f.timezone, locationId: f.locationId as string | null};
  if (filters.timezone !== context.timezone) throw new DataError('The store timezone has changed. Start a new export to avoid mixing date boundaries.');
  const error = validateFilters(filters);
  if (error) throw new DataError('Saved export filters are no longer valid: ' + error);
  let after: Pair | null = null;
  if (v.after !== null) {
    const a = v.after as Record<string, unknown> | undefined;
    if (!a || typeof a.itemId !== 'string' || typeof a.locationId !== 'string' || a.itemId.length > 30 || a.locationId.length > 30) throw new DataError('Saved export cursor is invalid.');
    after = {itemId: id(a.itemId), locationId: id(a.locationId)};
    if (filters.locationId && after.locationId !== filters.locationId) throw new DataError('Saved export cursor does not match its location filter.');
  }
  if ((v.completedRows === 0) !== (after === null) || (v.completedRows === 0 && v.nextPart !== 1) || Number(v.nextPart) > Number(v.completedRows) + 1) throw new DataError('Saved export counters are inconsistent.');
  return {version: 1, exportId: v.exportId, shopId: context.shopId, filters, startedAt: v.startedAt, nextPart: Number(v.nextPart), after, completedRows: Number(v.completedRows)};
}
function fileName(filters: Filters, exportId: string, part: number, hasMore: boolean): string {
  return `inventory-reconciliation-${filters.start}-${filters.end}-${exportId}-part-${String(part).padStart(4, '0')}${hasMore ? '' : '-final'}.csv`;
}

/** One CSV part at a time. No catalog-sized arrays and no background download loop.
 * A part is only returned after its contents have passed all report checks.
 * Save next only AFTER the user confirms they saved the current part.
 */
export async function prepareCsvPart(checkpoint: ExportCheckpoint, read: ExportReader, options: {
  signal?: AbortSignal; onProgress?: (progress: ExportProgress) => void;
  limits?: Partial<ExportLimits>; now?: () => number;
} = {}): Promise<CsvPart> {
  const limits = {...EXPORT_LIMITS, ...options.limits};
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 1)) throw new DataError('Invalid CSV export limits.');
  const now = options.now ?? Date.now, started = now();
  const job = {...checkpoint, filters: {...checkpoint.filters}, after: checkpoint.after ? {...checkpoint.after} : null};
  const signal = options.signal;
  const header = csvHeader(), encoder = new TextEncoder();
  const chunks = [encodeURIComponent(header)];
  let encodedBytes = CSV_DATA_PREFIX.length + chunks[0].length, csvBytes = encoder.encode(header).length;
  let rows = 0, pages = 0, after = job.after, missingBalances = 0, variances = 0;
  if (encodedBytes >= limits.maxEncodedBytes) throw new DataError('The CSV header exceeds the configured download limit.');
  const snapshot = (): ExportProgress => ({rows, pages, encodedBytes, csvBytes});
  const finish = (hasMore: boolean): CsvPart => {
    abortIfNeeded(signal);
    if (hasMore && rows === 0) throw new DataError('The export did not make progress. No partial file was produced.');
    return {...snapshot(), uri: CSV_DATA_PREFIX + chunks.join(''), filename: fileName(job.filters, job.exportId, job.nextPart, hasMore), filters: job.filters, exportId: job.exportId, part: job.nextPart, completedRowsBefore: job.completedRows, hasMore,
      next: hasMore ? {...job, after, nextPart: add(job.nextPart, 1), completedRows: add(job.completedRows, rows)} : null,
      missingBalances, variances, scope: 'selection'};
  };
  while (true) {
    abortIfNeeded(signal);
    if (pages >= limits.maxPages || (pages > 0 && now() - started >= limits.maxWorkMs)) return finish(true);
    const page = await read(after, signal);
    abortIfNeeded(signal);
    pages++;
    if (!sameFilters(page.filters, job.filters)) throw new DataError('Export filters changed during retrieval. No file was produced.');
    assertOrdered(page.rows, after);
    if (page.rows.length === 0 && page.hasNext) throw new DataError('Export pagination stopped advancing. No file was produced.');
    if (page.rows.length > 0 && (!page.next || key(page.next) !== key(page.rows[page.rows.length - 1]))) throw new DataError('Export received an inconsistent page cursor. No file was produced.');
    for (let i = 0; i < page.rows.length; i++) {
      abortIfNeeded(signal);
      const row = page.rows[i];
      const line = '\r\n' + csvRow(row, job.filters, page.fetchedAt, 'Filtered report export', job.exportId, job.nextPart);
      const encoded = encodeURIComponent(line);
      if (encodedBytes + encoded.length > limits.maxEncodedBytes || rows >= limits.maxRows) {
        if (rows === 0) throw new DataError('A CSV row exceeds the safe download size. Use a backend export for this selection.');
        return finish(true);
      }
      chunks.push(encoded); encodedBytes += encoded.length; csvBytes += encoder.encode(line).length;
      rows++;
      after = {itemId: row.itemId, locationId: row.locationId};
      if (row.status === 'missing') missingBalances++;
      if (row.status === 'variance') variances++;
      if (rows === limits.maxRows) {
        options.onProgress?.(snapshot());
        return finish(i < page.rows.length - 1 || page.hasNext);
      }
    }
    options.onProgress?.(snapshot());
    if (!page.hasNext) return finish(false);
    // Yield at every page boundary so cancellation/UI updates are not starved.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
export function currentPageFile(page: Page, pageNumber: number): CsvPart {
  const text = pageCsv(page), uri = CSV_DATA_PREFIX + encodeURIComponent(text);
  if (uri.length > EXPORT_LIMITS.maxEncodedBytes) throw new DataError('This page exceeds the safe download size. Export the selection in parts instead.');
  return {uri, filename: `inventory-reconciliation-${page.filters.start}-${page.filters.end}-page-${pageNumber}.csv`, filters: {...page.filters}, exportId: '', part: 1, completedRowsBefore: 0, hasMore: false, next: null, rows: page.rows.length, pages: 1, csvBytes: new TextEncoder().encode(text).length, encodedBytes: uri.length, missingBalances: page.rows.filter(r => r.status === 'missing').length, variances: page.rows.filter(r => r.status === 'variance').length, scope: 'page'};
}
