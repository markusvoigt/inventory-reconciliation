import test from 'node:test';
import assert from 'node:assert/strict';
import {Api, isRateLimited, normalize, retryAfterMs} from '../inventory-report/extensions/app-home/src/core/api.ts';
import {accumulate, compare, id, isoToday, joinWindow, key, quantity, reconcile, shiftDate, validateFilters, zeroAmounts} from '../inventory-report/extensions/app-home/src/core/domain.ts';
import {balanceQuery, detailQuery, literal, movementQuery} from '../inventory-report/extensions/app-home/src/core/queries.ts';
import {Reports} from '../inventory-report/extensions/app-home/src/core/report.ts';
import {pageCsv} from '../inventory-report/extensions/app-home/src/core/csv.ts';
import {MOVEMENT_ROW_LIMIT} from '../inventory-report/extensions/app-home/src/core/types.ts';
import type {GraphqlClient, Filters, GraphqlResult, QlRow} from '../inventory-report/extensions/app-home/src/core/types.ts';
import {syntheticClient, VIRTUAL_ITEMS} from '../preview/synthetic.ts';

const filters: Filters = {start: '2025-01-01', end: '2025-01-31', timezone: 'Europe/Berlin', locationId: null, sku: ''};
const pair = {itemId: '1000001', locationId: '1'};
const locations = [{id: '1', name: 'Warehouse', active: true}, {id: '2', name: 'Store', active: true}, {id: '3', name: 'Returns', active: true}];
const table = (rows: QlRow[]) => ({shopifyqlQuery: {parseErrors: [], tableData: {columns: Object.keys(rows[0] ?? {}).map(name => ({name})), rows}}});
const fastApi = (client: GraphqlClient, timeout = 30_000) => new Api(client, timeout, {minIntervalMs: 0, retryBaseMs: 0, jitter: 0});
function intercepted(change: (doc: string, variables: Record<string, unknown>, result: GraphqlResult<unknown>) => GraphqlResult<unknown>): GraphqlClient {
  return async <T>(doc: string, options?: {variables?: Record<string, unknown>}) => change(doc, options?.variables ?? {}, await syntheticClient(doc, options)) as GraphqlResult<T>;
}
const isMovement = (q: unknown) => String(q).startsWith('FROM inventory_adjustment_history');
const p = (itemId: string) => ({locationId: '1', itemId});

test('identifiers remain exact beyond Number.MAX_SAFE_INTEGER', () => {
  assert.equal(id('9007199254740993'), '9007199254740993');
  assert.throws(() => id(9007199254740993)); assert.throws(() => id(''));
  assert.equal(compare(p('9007199254740993'), p('9007199254740992')), 1);
});
test('null/malformed movements cannot silently become zero', () => {
  assert.equal(quantity(null, true), null);
  for (const value of [null, undefined, '', '1.2', 'NaN', '9007199254740992']) assert.throws(() => quantity(value));
  assert.equal(quantity('-12'), -12);
});
test('numeric overflow in aggregate is rejected', () => {
  const amounts = zeroAmounts(); amounts.other = Number.MAX_SAFE_INTEGER;
  assert.throws(() => accumulate(amounts, {...pair, reason: 'new_reason', referenceType: '', delta: 1}));
});
test('all categories conserve signed changes, including reversals', () => {
  const values = zeroAmounts();
  const movements = [
    {reason: 'purchase', referenceType: 'Order', delta: -8}, {reason: 'purchase', referenceType: 'Order', delta: 2},
    {reason: 'restock', referenceType: 'Refund', delta: 3}, {reason: 'restock', referenceType: 'Refund', delta: -1},
    {reason: 'shipment_received', referenceType: 'Inventory::Transfer', delta: 7}, {reason: 'transfer_canceled', referenceType: 'Inventory::Transfer', delta: -2},
    {reason: 'restock', referenceType: 'Return', delta: 1}, {reason: 'new_app_reason', referenceType: '', delta: -4},
  ];
  movements.forEach(m => accumulate(values, {...pair, ...m}));
  assert.deepEqual(values, {sold: 6, returns: 2, transfers: 5, other: -3});
  assert.equal(-values.sold + values.returns + values.transfers + values.other, movements.reduce((n, m) => n + m.delta, 0));
  assert.deepEqual(reconcile({...pair, opening: 10, closing: 8}, values), {expected: 8, variance: 0, status: 'matched'});
});
test('missing balances never produce a variance', () => {
  assert.deepEqual(reconcile({...pair, opening: null, closing: 5}, zeroAmounts()), {expected: null, variance: null, status: 'missing'});
});
test('complete union retains unchanged balances and movement-only items', () => {
  const result = joinWindow([p('1'), p('3')], [p('2'), p('3')], 2, 3, 10);
  assert.deepEqual(result.pairs.map(key), ['1:1', '1:2']); assert.equal(result.hasNext, true);
});
test('a clipped movement position and later balances are deferred, not zero-filled', () => {
  const result = joinWindow([p('1'), p('2'), p('3')], [p('1'), p('1'), p('2'), p('2')], 50, 51, 4);
  assert.deepEqual(result.pairs, [p('1')]); assert.equal(result.hasNext, true);
});
test('balance lookahead also limits the safe join frontier', () => {
  const result = joinWindow([p('1'), p('2'), p('3')], [p('1'), p('4'), p('5')], 50, 3, 10);
  assert.deepEqual(result.pairs, [p('1'), p('2')]); assert.equal(result.hasNext, true);
});
test('one oversize position fails closed rather than returning partial movement totals', () => {
  assert.throws(() => joinWindow([p('1')], [p('1'), p('1')], 50, 51, 2), /safety limit/);
});
test('an exact limit conservatively requires one more page', () => {
  assert.equal(joinWindow([p('1'), p('2')], [], 50, 2, 1000).hasNext, true);
  assert.equal(joinWindow([p('2')], [], 50, 2, 1000).hasNext, false);
});
test('bounded two-stream traversal loses no positions across sparse locations and clipped groups', () => {
  const positions = [1, 2, 3].flatMap(loc => Array.from({length: 30}, (_, i) => ({locationId: String(loc), itemId: String(i + 1)})));
  const allBalances = positions.filter(x => Number(x.itemId) % 3 !== 0);
  const allMovements = positions.filter(x => Number(x.itemId) % 5 !== 0).flatMap(x => Array.from({length: Number(x.itemId) % 7 + 1}, () => x));
  const expected = [...new Map([...allBalances, ...allMovements].map(x => [key(x), x])).values()].sort(compare).map(key);
  const visited: string[] = [];
  let after: {locationId: string; itemId: string} | null = null;
  let finished = false;
  for (let page = 0; page < 200; page++) {
    const b = allBalances.filter(x => !after || compare(x, after) > 0).slice(0, 6);
    const before = b.length === 6 ? b[5] : null;
    const m = allMovements.filter(x => (!after || compare(x, after) > 0) && (!before || compare(x, before) < 0)).slice(0, 17);
    const joined = joinWindow(b, m, 5, 6, 17);
    for (const position of joined.pairs) {
      assert.equal(m.filter(x => key(x) === key(position)).length, allMovements.filter(x => key(x) === key(position)).length);
      visited.push(key(position));
    }
    if (!joined.hasNext) { finished = true; break; }
    after = joined.pairs[joined.pairs.length - 1];
  }
  assert.equal(finished, true); assert.deepEqual(visited, expected);
});

test('timezone and DST handling do not use the machine timezone', () => {
  const moment = new Date('2026-03-28T23:30:00Z');
  assert.equal(isoToday('Europe/Berlin', moment), '2026-03-29');
  assert.equal(isoToday('America/Los_Angeles', moment), '2026-03-28');
  assert.equal(shiftDate('2026-03-30', -1), '2026-03-29');
  assert.match(validateFilters({...filters, start: '2025-02-30'}), /valid/);
  assert.match(validateFilters({...filters, end: '2026-10-01'}, new Date('2026-10-01T12:00Z')), /completed day/);
});
test('both queries push filters to Shopify and avoid per-SKU query fan-out', () => {
  const f = {...filters, locationId: '2', sku: "men's \\ tee"};
  const b = balanceQuery(f, pair), m = movementQuery(f, pair, p('1000052'));
  for (const q of [b, m]) {
    assert.match(q, /inventory_location_id = 2/); assert.match(q, /inventory_is_tracked = true/);
    assert.match(q, /inventory_location_id > 1/); assert.doesNotMatch(q, /OFFSET/);
    assert.ok(q.includes(literal(f.sku)));
  }
  assert.match(b, /product_title/); assert.match(m, /inventory_state = 'available'/);
  assert.match(m, /inventory_item_id < 1000052/); assert.doesNotMatch(m, /GROUP BY day|reference_document_uri|inventory_adjustment_count/);
  assert.throws(() => balanceQuery({...f, locationId: '1 OR 1=1'}, null));
  assert.throws(() => literal('evil\nquery'));
});
test('detail requests are item scoped and use actual adjustment IDs', () => {
  const q = detailQuery(filters, pair, 50);
  assert.match(q, /inventory_item_id = 1000001/); assert.match(q, /GROUP BY inventory_adjustment_id, second/); assert.match(q, /LIMIT 51 OFFSET 50/);
});
test('normalizer handles positional rows but fails on invalid nonempty schemas', () => {
  assert.deepEqual(normalize({columns: [{name: 'a'}], rows: [[1]]}, ['a']), [{a: 1}]);
  assert.throws(() => normalize({columns: [{name: 'a'}], rows: [{a: 1}]}, ['b']), /required columns missing: b/);
  assert.throws(() => normalize({columns: [{name: 'a'}], rows: [{}]}, ['a']));
});
test('explicitly empty tables do not require dimension columns', () => {
  assert.deepEqual(normalize({columns: [], rows: []}, ['inventory_item_id']), []);
  assert.deepEqual(normalize({columns: [{name: 'ending_inventory_units_at_location'}], rows: []}, ['inventory_item_id']), []);
  assert.throws(() => normalize({columns: [], rows: [{}]}, ['inventory_item_id']), /required columns missing/);
  assert.throws(() => normalize({columns: [], rows: null}, ['inventory_item_id']), /valid table/);
});
test('schema diagnostics expose names, not inventory values', async () => {
  const api = fastApi(async <T>() => ({data: table([{unexpected_metric: 42}]) as T}));
  await assert.rejects(api.ql('FROM inventory_by_location SHOW ending_inventory_units_at_location', ['inventory_location_id', 'inventory_item_id']), error => {
    const text = (error as Error).message;
    assert.ok(text.includes('Opening/closing balances (inventory_by_location)'));
    assert.match(text, /required columns missing: inventory_location_id, inventory_item_id/);
    assert.match(text, /Returned columns: unexpected_metric/); assert.ok(!text.includes('42')); return true;
  });
});
test('empty reports still use exactly two queries and invent no stock', async () => {
  let calls = 0;
  const report = await new Reports(fastApi(async <T>() => { calls++; return {data: table([]) as T}; })).page(filters, null, locations);
  assert.deepEqual(report.rows, []); assert.equal(report.hasNext, false); assert.equal(calls, 2);
});
test('missing table and genuine parse errors remain failures', async () => {
  const noTable = fastApi(async <T>() => ({data: {shopifyqlQuery: {parseErrors: [], tableData: null}} as T}));
  await assert.rejects(noTable.ql('FROM inventory', []), /not proof of zero/);
  const broken = fastApi(async <T>() => ({data: {shopifyqlQuery: {parseErrors: ['bad field']}} as T}));
  await assert.rejects(broken.ql('FROM inventory', []), /bad field/);
});
test('mutations are rejected without reaching the host', async () => {
  let called = false;
  const api = fastApi(async <T>() => { called = true; return {data: {} as T}; });
  await assert.rejects(api.graphql('mutation { anything }'), /read-only/); assert.equal(called, false);
});
test('all operations are serialized through one host-call gate', async () => {
  let active = 0, maximum = 0;
  const api = fastApi(async <T>() => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 2)); active--; return {data: {} as T}; });
  await Promise.all(Array.from({length: 20}, () => api.graphql('query Test { shop { name } }')));
  assert.equal(maximum, 1);
});
test('request starts are paced, including separate query operations', async () => {
  const starts: number[] = [];
  const api = new Api(async <T>() => { starts.push(Date.now()); return {data: {} as T}; }, 1000, {minIntervalMs: 15, jitter: 0});
  await Promise.all([api.graphql('query A'), api.graphql('query B')]);
  assert.ok(starts[1] - starts[0] >= 14);
});
test('cancelled queued calls never reach the host', async () => {
  let calls = 0;
  const api = fastApi(async <T>() => { calls++; await new Promise(r => setTimeout(r, 10)); return {data: {} as T}; });
  const tasks = [api.graphql('query A'), api.graphql('query B')];
  const controller = new AbortController(), queued = api.graphql('query C', {}, controller.signal);
  controller.abort(); await assert.rejects(queued, {name: 'AbortError'}); await Promise.all(tasks); assert.equal(calls, 2);
});
test('timeout fails closed', async () => {
  const api = fastApi(async <T>() => { await new Promise(r => setTimeout(r, 20)); return {data: {} as T}; }, 2);
  await assert.rejects(api.graphql('query Slow'), /No partial result/);
});
test('all known rate-limit forms are recognized', () => {
  for (const e of ['Rate limited. Please retry later.', new Error('Too many requests'), {status: 429}, {extensions: {code: 'THROTTLED'}}, {message: 'Rate limited. Please retry later.'}]) assert.equal(isRateLimited(e), true);
  assert.equal(isRateLimited(new Error('Access denied')), false);
  assert.equal(retryAfterMs({headers: {'Retry-After': '2'}}), 2000);
  assert.equal(retryAfterMs({headers: new Headers({'retry-after': '0.05'})}), 50);
});
test('a thrown host rate-limit error retries with bounded exponential backoff', async () => {
  let calls = 0; const delays: number[] = [];
  const api = new Api(async <T>() => { if (++calls <= 3) throw new Error('Rate limited. Please retry later.'); return {data: {} as T}; }, 1000, {minIntervalMs: 0, retryBaseMs: 2, jitter: 0});
  await api.graphql('query A', {}, undefined, ms => delays.push(ms));
  assert.equal(calls, 4); assert.deepEqual(delays, [2, 4, 8]);
});
test('GraphQL rate-limit text without an extensions code is retried', async () => {
  let calls = 0;
  const api = fastApi(async <T>() => ++calls === 1 ? {errors: [{message: 'Rate limited. Please retry later.'}]} : {data: {} as T});
  await api.graphql('query A'); assert.equal(calls, 2);
});
test('a rate-limit message in the analytics payload is retried too', async () => {
  let calls = 0;
  const api = fastApi(async <T>() => ({data: ++calls === 1 ? {shopifyqlQuery: {parseErrors: ['Rate limited. Please retry later.']}} as T : table([{a: 1}]) as T}));
  assert.deepEqual(await api.ql('FROM sales SHOW a', ['a']), [{a: 1}]); assert.equal(calls, 2);
});
test('permission errors and mixed GraphQL failures are never retried', async () => {
  let calls = 0;
  const api = fastApi(async () => { calls++; return {errors: [{message: 'Rate limited.'}, {message: 'Access denied'}]}; });
  await assert.rejects(api.graphql('query A'), /Access denied/); assert.equal(calls, 1);
});
test('rate-limit retry exhaustion does not loop indefinitely', async () => {
  let calls = 0;
  const api = fastApi(async () => { calls++; throw new Error('Rate limited. Please retry later.'); });
  await assert.rejects(api.graphql('query A'), /still rate limiting/); assert.equal(calls, 4);
});
test('Retry-After is honored and cancellation interrupts backoff', async () => {
  let calls = 0; const controller = new AbortController();
  const api = fastApi(async <T>() => { if (++calls === 1) throw Object.assign(new Error('429'), {status: 429, headers: new Headers({'Retry-After': '1'})}); return {data: {} as T}; });
  const task = api.graphql('query A', {}, controller.signal, ms => { assert.ok(ms >= 1000); controller.abort(); });
  await assert.rejects(task, {name: 'AbortError'}); assert.equal(calls, 1);
});
test('two-million-item catalog report uses exactly two analytics calls and no metadata calls', async () => {
  const calls: string[] = [];
  const reports = new Reports(fastApi(intercepted((doc, v, result) => { assert.match(doc, /ReconciliationAnalytics/); calls.push(String(v.query)); return result; })));
  const page = await reports.page(filters, null, locations);
  assert.equal(VIRTUAL_ITEMS, 2_000_000); assert.equal(page.rows.length, 50); assert.equal(page.hasNext, true); assert.equal(calls.length, 2);
  assert.ok(calls[0].startsWith('FROM inventory_by_location')); assert.ok(calls[1].startsWith('FROM inventory_adjustment_history'));
  assert.ok(page.rows.some(r => r.status === 'missing')); assert.ok(page.rows.some(r => Number(r.itemId) % 7 === 0 && r.sold === 0));
});
test('pages are disjoint and deep keyset seeks do not traverse prior pages', async () => {
  let calls = 0;
  const reports = new Reports(fastApi(intercepted((_doc, _v, result) => { calls++; return result; })));
  const first = await reports.page(filters, null, locations), second = await reports.page(filters, first.next, locations);
  const keys = new Set(first.rows.map(key)); assert.ok(second.rows.every(r => !keys.has(key(r))));
  const last = await reports.page(filters, {locationId: '3', itemId: '2999990'}, locations);
  assert.ok(last.rows.length < 10); assert.equal(last.hasNext, false); assert.equal(calls, 6);
});
test('a single SKU at one location also needs only two analytics calls', async () => {
  let calls = 0;
  const reports = new Reports(fastApi(intercepted((_doc, _v, result) => { calls++; return result; })));
  const page = await reports.page({...filters, sku: 'SKU-1000001', locationId: '2'}, null, locations);
  assert.equal(page.rows.length, 1); assert.equal(page.rows[0].locationId, '2'); assert.equal(page.rows[0].sku, 'SKU-1000001'); assert.equal(calls, 2);
});
test('movement failure does not present zero movements or a partial page', async () => {
  const reports = new Reports(fastApi(intercepted((_doc, v, result) => isMovement(v.query) ? {errors: [{message: 'Movement access denied'}]} : result)));
  await assert.rejects(reports.page(filters, null, locations), /Movement access denied/);
});
test('duplicate movement groups are rejected', async () => {
  const reports = new Reports(fastApi(intercepted((_doc, v, result) => {
    if (isMovement(v.query)) { const d = result.data as {shopifyqlQuery: {tableData: {rows: QlRow[]}}}; d.shopifyqlQuery.tableData.rows.splice(1, 0, {...d.shopifyqlQuery.tableData.rows[0]}); }
    return result;
  })));
  await assert.rejects(reports.page(filters, null, locations), /Duplicate movement groups/);
});
test('null movement quantity blocks the report', async () => {
  const reports = new Reports(fastApi(intercepted((_doc, v, result) => {
    if (isMovement(v.query)) { const d = result.data as {shopifyqlQuery: {tableData: {rows: QlRow[]}}}; d.shopifyqlQuery.tableData.rows[0].inventory_adjustment_change = null; }
    return result;
  })));
  await assert.rejects(reports.page(filters, null, locations), /quantity is missing/);
});
test('an item clipped at the movement row limit is fully recovered on the next page', async () => {
  let calls = 0;
  const source: GraphqlClient = async <T>(_doc: string, options?: {variables?: Record<string, unknown>}) => {
    calls++;
    const q = String(options?.variables?.query);
    const after = Number(q.match(/inventory_item_id > (\d+)/)?.[1] ?? 0);
    const rows: QlRow[] = q.startsWith('FROM inventory_by_location')
      ? [1, 2, 3].filter(i => i > after).map(i => ({inventory_location_id: '1', inventory_item_id: String(i), starting_inventory_units_at_location: 0, ending_inventory_units_at_location: i < 3 ? 600 : 0}))
      : [1, 2].filter(i => i > after).flatMap(i => Array.from({length: 600}, (_, j) => ({inventory_location_id: '1', inventory_item_id: String(i), inventory_change_reason: `reason-${String(j).padStart(4, '0')}`, reference_document_type: '', inventory_adjustment_change: 1}))).slice(0, MOVEMENT_ROW_LIMIT);
    return {data: table(rows) as T};
  };
  const reports = new Reports(fastApi(source));
  const first = await reports.page(filters, null, locations);
  assert.deepEqual(first.rows.map(r => r.itemId), ['1']); assert.equal(first.rows[0].other, 600); assert.equal(first.hasNext, true);
  const second = await reports.page(filters, first.next, locations);
  assert.deepEqual(second.rows.map(r => r.itemId), ['2', '3']); assert.equal(second.rows[0].other, 600);
  assert.ok(second.rows.every(r => r.variance === 0)); assert.equal(second.hasNext, false); assert.equal(calls, 4);
});
test('CSV remains page-scoped and neutralizes spreadsheet formulas', async () => {
  const page = await new Reports(fastApi(syntheticClient)).page(filters, null, locations);
  page.rows[0].sku = '=HYPERLINK("https://bad.invalid")';
  const csv = pageCsv(page); assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes('Current page only'));
  assert.ok(csv.includes('2025-01-01')); assert.equal(csv.split('\r\n').length, 51);
});
test('export and browsing window sizes produce the same ordered reconciliation rows', async () => {
  const reports = new Reports(fastApi(syntheticClient));
  const gather = async (size: number) => {
    const rows = []; let after = null;
    while (rows.length < 1000) {
      const page = await reports.page(filters, after, locations, undefined, undefined, size);
      rows.push(...page.rows); after = page.next;
      if (!page.hasNext) break;
    }
    return rows.slice(0, 1000);
  };
  assert.deepEqual(await gather(50), await gather(500));
});

test('store settings are loaded separately, not on each report run', async () => {
  const context = await new Reports(fastApi(syntheticClient)).context();
  assert.equal(context.timezone, 'Europe/Berlin'); assert.equal(context.locations.length, 3);
});
