import {performance} from 'node:perf_hooks';
import {mkdir, writeFile} from 'node:fs/promises';
import {Api} from '../inventory-report/extensions/app-home/src/core/api.ts';
import {Reports} from '../inventory-report/extensions/app-home/src/core/report.ts';
import {syntheticClient, VIRTUAL_ITEMS} from '../preview/synthetic.ts';
let calls = 0, largestResponse = 0, maximumPageRows = 0;
const api = new Api(async (doc, variables) => {
  calls++;
  const result = await syntheticClient(doc, variables);
  largestResponse = Math.max(largestResponse, result.data?.shopifyqlQuery?.tableData?.rows?.length ?? 0);
  return result;
}, 30_000, {minIntervalMs: 0, retryBaseMs: 0, jitter: 0});
const reports = new Reports(api);
const filters = {start: '2025-01-01', end: '2025-01-31', locationId: null, sku: '', timezone: 'Europe/Berlin'};
let cursor = null;
const started = performance.now();
const durations = [];
for (let i = 0; i < 100; i++) {
  const t = performance.now();
  const page = await reports.page(filters, cursor, []);
  maximumPageRows = Math.max(maximumPageRows, page.rows.length);
  cursor = page.next;
  durations.push(performance.now() - t);
}
// Seek to the final location without traversing the preceding six million positions.
const end = await reports.page(filters, {itemId: '2999990', locationId: '3'}, []);
if (end.hasNext || end.rows.length >= 10) throw new Error('End-of-catalog seek failed.');
durations.sort((a, b) => a - b);
const result = {
  kind: 'Synthetic client benchmark. Not a live Shopify throughput test.',
  virtualCatalogItems: VIRTUAL_ITEMS,
  virtualLocations: 3,
  virtualInventoryPositions: VIRTUAL_ITEMS * 3,
  pagesBrowsed: 100,
  apiCallsIncludingFinalSeek: calls,
  maximumPageRows,
  largestAnalyticsResponseRows: largestResponse,
  totalMilliseconds: Number((performance.now() - started).toFixed(2)),
  medianPageMilliseconds: Number(durations[50].toFixed(2)),
  p95PageMilliseconds: Number(durations[95].toFixed(2)),
  qualification: 'Transport is generated in memory and has no network latency. This measures the client strategy, not Shopify execution time, catalog completeness, or accounting correctness.'
};
await mkdir(new URL('../docs/', import.meta.url), {recursive: true});
await writeFile(new URL('../docs/synthetic-benchmark.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
