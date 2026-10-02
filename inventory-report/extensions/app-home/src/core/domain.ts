import type {Amounts, Balance, Category, Cell, Filters, Movement, Pair, ReportRow} from './types.ts';

export class DataError extends Error { override name = 'DataError'; }
export function id(value: Cell | undefined): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new DataError('An inventory identifier exceeds safe numeric precision.');
  const text = String(value ?? '');
  if (!/^[1-9]\d*$/.test(text)) throw new DataError('Missing or invalid inventory/location identifier.');
  return text;
}
export function quantity(value: Cell | undefined, nullable = false): number | null {
  if (value === null || value === undefined || value === '') {
    if (nullable) return null;
    throw new DataError('A movement quantity is missing. It cannot be treated as zero.');
  }
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new DataError('An inventory quantity is not an integer.');
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new DataError('An inventory quantity exceeds safe numeric precision.');
  return n;
}
export function add(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new DataError('Inventory totals exceed safe numeric precision.');
  return result;
}
export function key(pair: Pair): string { return pair.locationId + ':' + pair.itemId; }
export function compare(a: Pair, b: Pair): number {
  const al = BigInt(a.locationId), bl = BigInt(b.locationId);
  if (al !== bl) return al < bl ? -1 : 1;
  const ai = BigInt(a.itemId), bi = BigInt(b.itemId);
  return ai === bi ? 0 : ai < bi ? -1 : 1;
}
export function readPair(row: Record<string, Cell>): Pair {
  return {itemId: id(row.inventory_item_id), locationId: id(row.inventory_location_id)};
}
export function zeroAmounts(): Amounts { return {sold: 0, returns: 0, transfers: 0, other: 0}; }
// Conservative, explicit rules. Signed reversals stay signed. All other reasons remain visible.
// These are reporting conventions, not a claim to capture all return workflows.
export function classify(reason: string, referenceType: string): Category {
  const r = reason.toLowerCase(), ref = referenceType.toLowerCase();
  if (ref === 'inventory::transfer') return 'transfers';
  if (r === 'purchase') return 'sold';
  if (r === 'restock' && ref === 'refund') return 'returns';
  return 'other';
}
export function accumulate(amounts: Amounts, movement: Movement): void {
  const category = classify(movement.reason, movement.referenceType);
  amounts[category] = add(amounts[category], category === 'sold' ? -movement.delta : movement.delta);
}
export function reconcile(balance: Balance, amounts: Amounts): Pick<ReportRow, 'expected' | 'variance' | 'status'> {
  if (balance.opening === null || balance.closing === null) return {expected: null, variance: null, status: 'missing'};
  const expected = add(add(add(add(balance.opening, -amounts.sold), amounts.returns), amounts.transfers), amounts.other);
  const variance = add(balance.closing, -expected);
  return {expected, variance, status: variance === 0 ? 'matched' : 'variance'};
}
export function assertOrdered(pairs: Pair[], after: Pair | null): void {
  let previous = after;
  for (const pair of pairs) {
    if (previous && compare(previous, pair) >= 0) throw new DataError('Analytics returned duplicate or unordered item/location keys. Refresh the report.');
    previous = pair;
  }
}
/** Join two bounded, sorted result streams without zero-filling beyond their coverage.
 * If a source hits its limit, its final pair is an EXCLUSIVE boundary: that pair
 * may be incomplete. It is retried from scratch on the next page, not discarded.
 */
export function joinWindow(balances: Pair[], movementRows: Pair[], size: number, balanceLimit: number, movementLimit: number): {pairs: Pair[]; hasNext: boolean} {
  if (balances.length > balanceLimit || movementRows.length > movementLimit) throw new DataError('Analytics ignored a requested row limit.');
  const boundaries: Pair[] = [];
  if (balances.length === balanceLimit) boundaries.push(balances[balances.length - 1]);
  if (movementRows.length === movementLimit) boundaries.push(movementRows[movementRows.length - 1]);
  const frontier = boundaries.sort(compare)[0];
  const map = new Map<string, Pair>();
  for (const pair of [...balances, ...movementRows]) {
    if (!frontier || compare(pair, frontier) < 0) map.set(key(pair), pair);
  }
  const sorted = [...map.values()].sort(compare);
  const hasNext = sorted.length > size || !!frontier;
  if (hasNext && sorted.length === 0) {
    throw new DataError('One inventory position exceeds the movement-group safety limit. Narrow the period. No partial reconciliation was calculated.');
  }
  return {pairs: sorted.slice(0, size), hasNext};
}
export function isoToday(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)!.value;
  return get('year') + '-' + get('month') + '-' + get('day');
}
export function shiftDate(value: string, days: number): string {
  const d = new Date(value + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
}
export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
}
export function validateFilters(f: Filters, now = new Date()): string {
  if (!validDate(f.start) || !validDate(f.end)) return 'Select a valid start and end date.';
  if (f.start > f.end) return 'Start date must be on or before end date.';
  if (f.end >= isoToday(f.timezone, now)) return 'Choose a completed day. Today’s balances and movements are still changing.';
  if (f.sku.length > 120 || /[\r\n\u0000-\u001f]/.test(f.sku)) return 'Enter a SKU of at most 120 characters without control characters.';
  if (f.locationId !== null) { try { id(f.locationId); } catch { return 'Select a valid inventory location.'; } }
  return '';
}
export function sameFilters(a: Filters, b: Filters): boolean {
  return a.start === b.start && a.end === b.end && a.locationId === b.locationId && a.sku === b.sku && a.timezone === b.timezone;
}
