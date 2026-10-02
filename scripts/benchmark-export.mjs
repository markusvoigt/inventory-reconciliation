import {performance} from 'node:perf_hooks';
import {mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createExport, CSV_DATA_PREFIX, EXPORT_LIMITS, prepareCsvPart} from '../inventory-report/extensions/app-home/src/core/export.ts';

const total = Number(process.argv[2] ?? 1_000_000);
if (!Number.isSafeInteger(total) || total < 1) throw new Error('Pass a positive row count.');
const filters = {start: '2025-01-01', end: '2025-01-31', locationId: '1', sku: '', timezone: 'Europe/Berlin'};
const context = {shopId: 'gid://shopify/Shop/1', shopName: 'Synthetic export', timezone: filters.timezone, locations: []};
let calls = 0, largestInputPage = 0;
const reader = async after => {
  calls++;
  const start = after ? Number(after.itemId) : 0;
  const rows = Array.from({length: Math.min(500, total - start)}, (_, index) => {
    const i = start + index + 1;
    return {locationId: '1', itemId: String(i), locationName: 'Synthetic warehouse', sku: `SKU-${i}`, title: 'Synthetic product', variant: 'Default Title', opening: 30, sold: 6, returns: 1, transfers: 0, other: 0, closing: 25, expected: 25, variance: 0, status: 'matched'};
  });
  largestInputPage = Math.max(largestInputPage, rows.length);
  return {rows, after, next: rows.length ? {itemId: rows[rows.length - 1].itemId, locationId: '1'} : null, hasNext: start + rows.length < total, filters, fetchedAt: '2025-02-01T00:00:00Z'};
};
let checkpoint = createExport(context, filters), exportedRows = 0, parts = 0, maxEncodedBytes = 0, maxPartRows = 0;
let maximumHeapAfterGc = 0;
const started = performance.now();
while (true) {
  const part = await prepareCsvPart(checkpoint, reader);
  const csv = decodeURIComponent(part.uri.slice(CSV_DATA_PREFIX.length));
  const first = csv.slice(csv.indexOf('\r\n') + 2).split('\r\n', 1)[0].split(',')[4].replaceAll('"', '');
  const last = csv.slice(csv.lastIndexOf('\r\n') + 2).split(',')[4].replaceAll('"', '');
  assert.equal(first, String(exportedRows + 1));
  assert.equal(last, String(exportedRows + part.rows));
  assert.ok(part.encodedBytes <= EXPORT_LIMITS.maxEncodedBytes);
  assert.ok(part.rows <= EXPORT_LIMITS.maxRows);
  exportedRows += part.rows; parts++;
  maxEncodedBytes = Math.max(maxEncodedBytes, part.encodedBytes);
  maxPartRows = Math.max(maxPartRows, part.rows);
  if (globalThis.gc && parts % 20 === 0) { globalThis.gc(); maximumHeapAfterGc = Math.max(maximumHeapAfterGc, process.memoryUsage().heapUsed); }
  if (!part.hasMore) break;
  assert.equal(part.next.completedRows, exportedRows);
  assert.equal(part.next.after.itemId, last);
  // Test harness acknowledges each part immediately. The UI requires explicit download confirmation.
  checkpoint = part.next;
}
assert.equal(exportedRows, total);
const result = {
  kind: 'Synthetic CSV-core traversal. Not a live Shopify or unattended browser-export benchmark.',
  exportedRows, parts, readerCalls: calls, largestInputPage, maximumPartRows: maxPartRows,
  maximumEncodedDownloadBytes: maxEncodedBytes, encodedDownloadLimit: EXPORT_LIMITS.maxEncodedBytes,
  maximumObservedHeapAfterGc: globalThis.gc ? maximumHeapAfterGc : null,
  totalMilliseconds: Number((performance.now() - started).toFixed(2)),
  qualification: 'Rows are generated in memory. No Shopify API latency, throttling, browser IPC or download time is measured. Only one bounded CSV part is retained; the harness simulates saved-file confirmation. Real extension exports pause between parts and stop on app closure.'
};
await mkdir(new URL('../docs/', import.meta.url), {recursive: true});
await writeFile(new URL('../docs/export-benchmark.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
