import test from 'node:test';
import assert from 'node:assert/strict';
import {CSV_DATA_PREFIX, createExport, currentPageFile, EXPORT_LIMITS, parseCheckpoint, prepareCsvPart} from '../inventory-report/extensions/app-home/src/core/export.ts';
import type {ExportCheckpoint, ExportReader} from '../inventory-report/extensions/app-home/src/core/export.ts';
import {csvCell, csvHeader, csvRow} from '../inventory-report/extensions/app-home/src/core/csv.ts';
import type {Context, Filters, Page, ReportRow} from '../inventory-report/extensions/app-home/src/core/types.ts';
import {Api} from '../inventory-report/extensions/app-home/src/core/api.ts';
import {Reports} from '../inventory-report/extensions/app-home/src/core/report.ts';
import {syntheticClient} from '../preview/synthetic.ts';

const filters: Filters = {start: '2025-01-01', end: '2025-01-31', locationId: null, sku: '', timezone: 'Europe/Berlin'};
const context: Context = {shopId: 'gid://shopify/Shop/1', shopName: 'Synthetic', timezone: filters.timezone, locations: []};
function job(): ExportCheckpoint { return {...createExport(context, filters), exportId: 'test-export-01'}; }
function row(i: number): ReportRow {
  return {itemId: String(i), locationId: '1', locationName: 'Warehouse', sku: `SKU-${i}`, title: 'Product', variant: 'Default Title', opening: 12, closing: 10, sold: 2, returns: 0, transfers: 0, other: 0, expected: 10, variance: 0, status: 'matched'};
}
function source(total: number, size = 50, customize?: (row: ReportRow) => ReportRow): ExportReader {
  return async (after): Promise<Page> => {
    const start = after ? Number(after.itemId) : 0;
    const rows = Array.from({length: Math.min(size, total - start)}, (_, i) => customize ? customize(row(start + i + 1)) : row(start + i + 1));
    return {rows, after, next: rows.length ? {itemId: rows[rows.length - 1].itemId, locationId: '1'} : null, hasNext: start + rows.length < total, filters, fetchedAt: '2025-02-01T00:00:00Z'};
  };
}
function text(uri: string) { return decodeURIComponent(uri.slice(CSV_DATA_PREFIX.length)); }
function ids(uri: string): string[] { return text(uri).split('\r\n').slice(1).map(line => line.split(',')[4].replaceAll('"', '')); }

test('CSV escapes commas, quotes and line breaks and neutralizes formula strings only', () => {
  assert.equal(csvCell('comma, "quote"\r\nnext'), '"comma, ""quote""\r\nnext"');
  assert.equal(csvCell('=1+1'), '"\'=1+1"');
  assert.equal(csvCell('  @SUM(A1)'), '"\'  @SUM(A1)"');
  assert.equal(csvCell(-4), '"-4"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell('001234'), '"001234"');
});
test('Unicode and invalid surrogate labels cannot crash URI encoding', () => {
  assert.ok(csvHeader().startsWith('\uFEFF'));
  assert.doesNotThrow(() => encodeURIComponent(csvCell('日本語 🛍️ \uD800')));
  assert.ok(csvCell('日本語 🛍️').includes('日本語 🛍️'));
});
test('a complete selection exports every row across pages, not only the visible page', async () => {
  const result = await prepareCsvPart(job(), source(137));
  assert.equal(result.rows, 137); assert.equal(result.pages, 3); assert.equal(result.hasMore, false); assert.equal(result.next, null);
  assert.match(result.filename, /part-0001-final.csv$/);
  assert.deepEqual(ids(result.uri), Array.from({length: 137}, (_, i) => String(i + 1)));
  assert.ok(text(result.uri).includes('Filtered report export'));
});
test('row-boundary splitting resumes inside a previously read page without gaps or duplicates', async () => {
  let checkpoint = job(); const exported: string[] = [];
  let parts = 0;
  while (true) {
    const part = await prepareCsvPart(checkpoint, source(11, 5), {limits: {maxRows: 3}});
    exported.push(...ids(part.uri)); parts++;
    assert.ok(part.rows <= 3);
    if (!part.hasMore) break;
    assert.equal(part.next!.completedRows, exported.length);
    assert.equal(part.next!.after!.itemId, exported[exported.length - 1]);
    checkpoint = part.next!;
  }
  assert.equal(parts, 4); assert.deepEqual(exported, Array.from({length: 11}, (_, i) => String(i + 1)));
});
test('encoded download size is bounded, including Unicode expansion', async () => {
  const reader = source(20, 10, r => ({...r, title: '日本語 🛍️ '.repeat(4)}));
  let checkpoint = job(); const exported: string[] = [];
  while (true) {
    const part = await prepareCsvPart(checkpoint, reader, {limits: {maxEncodedBytes: 2400}});
    assert.ok(part.uri.length <= 2400); assert.equal(part.encodedBytes, part.uri.length);
    assert.equal(part.csvBytes, new TextEncoder().encode(text(part.uri)).length);
    exported.push(...ids(part.uri));
    if (!part.hasMore) break;
    checkpoint = part.next!;
  }
  assert.deepEqual(exported, Array.from({length: 20}, (_, i) => String(i + 1)));
});
test('an oversized row fails instead of truncating its content', async () => {
  await assert.rejects(prepareCsvPart(job(), source(1, 1, r => ({...r, title: 'x'.repeat(5000)})), {limits: {maxEncodedBytes: 2000}}), /row exceeds/);
});
test('processing budgets produce an explicitly nonfinal part with a valid resume cursor', async () => {
  const part = await prepareCsvPart(job(), source(20, 2), {limits: {maxPages: 1}});
  assert.equal(part.rows, 2); assert.equal(part.pages, 1); assert.equal(part.hasMore, true); assert.equal(part.next!.after!.itemId, '2');
  let clock = 0;
  const timed = await prepareCsvPart(job(), source(20, 2), {limits: {maxWorkMs: 1}, now: () => clock += 10});
  assert.equal(timed.rows, 2); assert.equal(timed.hasMore, true);
});
test('exact final row limit does not falsely claim that more data remains', async () => {
  const part = await prepareCsvPart(job(), source(6, 3), {limits: {maxRows: 6}});
  assert.equal(part.rows, 6); assert.equal(part.hasMore, false);
});
test('empty selections produce a header-only complete CSV', async () => {
  const part = await prepareCsvPart(job(), source(0));
  assert.equal(part.rows, 0); assert.equal(part.hasMore, false); assert.equal(text(part.uri), csvHeader());
});
test('API failure after completed pages does not expose an unfinished file or advance the input checkpoint', async () => {
  const checkpoint = job(); const before = JSON.stringify(checkpoint);
  const reader: ExportReader = async after => { if (after) throw new Error('Source failed'); return source(10, 2)(after); };
  await assert.rejects(prepareCsvPart(checkpoint, reader), /Source failed/);
  assert.equal(JSON.stringify(checkpoint), before);
});
test('cancellation discards the unfinished part and stops additional pages', async () => {
  const controller = new AbortController(); let calls = 0;
  const reader: ExportReader = async after => { calls++; const page = await source(20, 2)(after); controller.abort(); return page; };
  await assert.rejects(prepareCsvPart(job(), reader, {signal: controller.signal}), {name: 'AbortError'});
  assert.equal(calls, 1);
});
test('non-advancing or inconsistent cursors cannot create infinite exports', async () => {
  const emptyLoop: ExportReader = async after => ({rows: [], filters, after, next: after, hasNext: true, fetchedAt: '2025-02-01T00:00:00Z'});
  await assert.rejects(prepareCsvPart(job(), emptyLoop), /stopped advancing/);
  const badCursor: ExportReader = async after => ({...await source(2)(after), next: {itemId: '999', locationId: '1'}});
  await assert.rejects(prepareCsvPart(job(), badCursor), /inconsistent page cursor/);
});
test('filter changes are detected before rows are exported', async () => {
  const reader: ExportReader = async after => ({...await source(2)(after), filters: {...filters, locationId: '2'}});
  await assert.rejects(prepareCsvPart(job(), reader), /filters changed/i);
});
test('missing balances and variances are included and counted, not dropped', async () => {
  const part = await prepareCsvPart(job(), source(3, 3, r => r.itemId === '1' ? {...r, opening: null, expected: null, variance: null, status: 'missing'} : {...r, variance: 2, status: 'variance'}));
  assert.equal(part.rows, 3); assert.equal(part.missingBalances, 1); assert.equal(part.variances, 2);
  assert.ok(text(part.uri).includes('"missing"')); assert.ok(text(part.uri).includes('"variance"'));
});
test('resume checkpoints are validated and cannot be used for a different store or timezone', async () => {
  const checkpoint = job(); assert.deepEqual(parseCheckpoint(checkpoint, context), checkpoint);
  const part = await prepareCsvPart(checkpoint, source(10), {limits: {maxRows: 3}});
  assert.deepEqual(parseCheckpoint(part.next, context), part.next);
  assert.throws(() => parseCheckpoint(checkpoint, {...context, shopId: 'gid://shopify/Shop/2'}), /different store/);
  assert.throws(() => parseCheckpoint(checkpoint, {...context, timezone: 'America/New_York'}), /timezone/);
  assert.throws(() => parseCheckpoint({...checkpoint, nextPart: -1}, context), /invalid/);
  assert.throws(() => parseCheckpoint({...checkpoint, exportId: '../../escape'}, context), /invalid/);
  assert.throws(() => parseCheckpoint({...checkpoint, after: {locationId: '1', itemId: '1'}}, context), /inconsistent/);
});
test('preparing does not mutate the caller filters or checkpoint', async () => {
  const checkpoint = job(); const before = JSON.stringify(checkpoint);
  await prepareCsvPart(checkpoint, source(8), {limits: {maxRows: 3}});
  assert.equal(JSON.stringify(checkpoint), before);
});
test('current-page export remains explicit and preserves committed filters', async () => {
  const page = await source(10, 5)(null);
  const part = currentPageFile(page, 2);
  assert.equal(part.rows, 5); assert.equal(part.scope, 'page'); assert.match(part.filename, /page-2.csv$/);
  assert.ok(text(part.uri).includes('Current page only')); assert.ok(text(part.uri).includes('2025-01-01'));
});
test('export retrieval uses larger bounded windows and still exactly two operations per page', async () => {
  let calls = 0;
  const api = new Api(async <T>(q: string, options?: {variables?: Record<string, unknown>}) => { calls++; return syntheticClient<T>(q, options); }, 30000, {minIntervalMs: 0, retryBaseMs: 0, jitter: 0});
  const reports = new Reports(api);
  const result = await reports.page(filters, null, [], undefined, undefined, 500);
  assert.equal(result.rows.length, 500); assert.equal(calls, 2);
  await assert.rejects(reports.page(filters, null, [], undefined, undefined, 501), /page size/);
});
test('download caps are application guardrails, not unbounded array growth', async () => {
  const part = await prepareCsvPart(job(), source(1_000_000, 500));
  assert.equal(part.hasMore, true);
  assert.ok(part.rows <= EXPORT_LIMITS.maxRows); assert.ok(part.encodedBytes <= EXPORT_LIMITS.maxEncodedBytes);
  assert.ok(part.pages <= EXPORT_LIMITS.maxPages); assert.ok(part.next!.after);
});
test('CSV rows expose export ID and part number for safe manual combination', () => {
  const encoded = csvRow(row(1), filters, '2025-02-01T00:00:00Z', 'Filtered report export', 'test-export-01', 3);
  assert.ok(encoded.endsWith('"test-export-01","3"'));
});
