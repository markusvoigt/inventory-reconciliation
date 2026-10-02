import {Api, abortIfNeeded} from './api.ts';
import {accumulate, assertOrdered, classify, compare, DataError, id, joinWindow, key, quantity, readPair, reconcile, validateFilters, zeroAmounts} from './domain.ts';
import {balanceQuery, detailQuery, LOCATIONS, movementQuery, SHOP} from './queries.ts';
import {DETAIL_PAGE_SIZE, EXPORT_PAGE_SIZE, MOVEMENT_ROW_LIMIT, PAGE_SIZE} from './types.ts';
import type {Amounts, Balance, Context, DetailPage, Filters, Location, Metadata, Page, Pair, QlRow} from './types.ts';

const PAIR_COLUMNS = ['inventory_location_id', 'inventory_item_id'];
function labels(row: QlRow): Metadata {
  return {sku: row.product_variant_sku == null ? null : String(row.product_variant_sku), title: row.product_title == null ? null : String(row.product_title), variant: row.product_variant_title == null ? null : String(row.product_variant_title)};
}
export class Reports {
  private api: Api;
  constructor(api: Api) { this.api = api; }

  async context(signal?: AbortSignal): Promise<Context> {
    const data = await this.api.graphql<{shop: {id: string; name: string; ianaTimezone: string}}>(SHOP, {}, signal);
    if (!data.shop?.ianaTimezone || !data.shop.id?.startsWith('gid://shopify/Shop/')) throw new DataError('The store identity or timezone could not be read.');
    id(data.shop.id.slice('gid://shopify/Shop/'.length));
    new Intl.DateTimeFormat('en', {timeZone: data.shop.ianaTimezone}).format();
    const locations: Location[] = [];
    let after: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 40; page++) {
      type Response = {locations: {nodes: {id: string; name: string; isActive: boolean}[]; pageInfo: {hasNextPage: boolean; endCursor: string | null}}};
      const result: Response = await this.api.graphql<Response>(LOCATIONS, {after}, signal);
      const connection = result.locations;
      if (!connection?.pageInfo || !Array.isArray(connection.nodes)) throw new DataError('Locations could not be loaded completely.');
      locations.push(...connection.nodes.map(l => ({id: id(l.id.split('/').pop()), name: l.name, active: l.isActive})));
      if (!connection.pageInfo.hasNextPage) return {shopId: data.shop.id, timezone: data.shop.ianaTimezone, shopName: data.shop.name, locations};
      const cursor = connection.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) throw new DataError('Location pagination did not advance.');
      cursors.add(cursor); after = cursor;
    }
    throw new DataError('The store has more locations than this client can load safely.');
  }

  async page(filters: Filters, after: Pair | null, locations: Location[], signal?: AbortSignal, progress: (text: string) => void = () => {}, pageSize = PAGE_SIZE): Promise<Page> {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > EXPORT_PAGE_SIZE) throw new DataError('Invalid report page size.');
    const error = validateFilters(filters);
    if (error) throw new DataError(error);
    const f = Object.freeze({...filters});
    const retry = (ms: number, attempt: number) => progress(`Shopify is rate limiting requests. Retrying in ${Math.ceil(ms / 1000)}s (${attempt}/3)…`);

    // Exactly two analytics operations on the success path. They are sequential
    // and globally paced, not fanned out into discovery + per-item calls.
    progress('Loading opening and closing balances (1/2)…');
    const b = await this.api.ql(balanceQuery(f, after, pageSize), [...PAIR_COLUMNS, 'starting_inventory_units_at_location', 'ending_inventory_units_at_location'], signal, retry);
    abortIfNeeded(signal);
    const balances: (Balance & Metadata)[] = b.map(row => ({...readPair(row), ...labels(row), opening: quantity(row.starting_inventory_units_at_location, true), closing: quantity(row.ending_inventory_units_at_location, true)}));
    assertOrdered(balances, after);
    if (balances.length > pageSize + 1) throw new DataError('Analytics ignored the balance row limit.');
    // Constrain the second query to the balance lookahead key when available.
    // This keeps ordinary pages small without issuing a query for each SKU.
    const before = balances.length === pageSize + 1 ? balances[balances.length - 1] : null;
    progress('Loading grouped inventory movements (2/2)…');
    const m = await this.api.ql(movementQuery(f, after, before), [...PAIR_COLUMNS, 'inventory_adjustment_change', 'inventory_change_reason', 'reference_document_type'], signal, retry);
    abortIfNeeded(signal);
    const movementPairs = m.map(readPair);
    let previous = after;
    const seen = new Set<string>();
    for (let i = 0; i < m.length; i++) {
      const pair = movementPairs[i], row = m[i];
      if ((after && compare(pair, after) <= 0) || (before && compare(pair, before) >= 0) || (previous && compare(pair, previous) < 0)) throw new DataError('Movement results are unordered or outside the requested key range. No partial result was used.');
      previous = pair;
      const identity = JSON.stringify([key(pair), row.inventory_change_reason, row.reference_document_type, row.product_variant_sku, row.product_variant_title]);
      if (seen.has(identity)) throw new DataError('Duplicate movement groups were returned. No partial result was used.');
      seen.add(identity);
      quantity(row.inventory_adjustment_change); // A null change is not zero, even on a deferred row.
    }
    const window = joinWindow(balances, movementPairs, pageSize, pageSize + 1, MOVEMENT_ROW_LIMIT);
    const selected = new Set(window.pairs.map(key));
    const amounts = new Map<string, Amounts>();
    const movementLabels = new Map<string, Metadata>();
    for (const pair of window.pairs) amounts.set(key(pair), zeroAmounts());
    for (let i = 0; i < m.length; i++) {
      const pair = movementPairs[i], k = key(pair), row = m[i];
      if (!selected.has(k)) continue;
      accumulate(amounts.get(k)!, {...pair, reason: String(row.inventory_change_reason ?? ''), referenceType: String(row.reference_document_type ?? ''), delta: quantity(row.inventory_adjustment_change)!});
      if (!movementLabels.has(k)) movementLabels.set(k, labels(row));
    }
    const balanceMap = new Map(balances.map(row => [key(row), row]));
    const locationMap = new Map(locations.map(l => [l.id, l.name]));
    const rows = window.pairs.map(pair => {
      const k = key(pair);
      const balance = balanceMap.get(k);
      const position = balance ?? {...pair, opening: null, closing: null, ...(movementLabels.get(k) ?? {sku: null, title: null, variant: null})};
      const values = amounts.get(k)!;
      return {...position, ...values, locationName: locationMap.get(pair.locationId) ?? `Location ${pair.locationId}`, ...reconcile(position, values)};
    });
    return {rows, filters: f, after, next: rows.length ? {itemId: rows[rows.length - 1].itemId, locationId: rows[rows.length - 1].locationId} : null, hasNext: window.hasNext, fetchedAt: new Date().toISOString()};
  }

  async details(f: Filters, pair: Pair, offset: number, signal?: AbortSignal): Promise<DetailPage> {
    const rows = await this.api.ql(detailQuery(f, pair, offset), ['inventory_adjustment_id', 'second', 'inventory_change_reason', 'reference_document_type', 'reference_document_uri', 'inventory_adjustment_change'], signal);
    if (rows.length > DETAIL_PAGE_SIZE + 1) throw new DataError('Analytics ignored the detail page size.');
    const seen = new Set<string>();
    const mapped = rows.slice(0, DETAIL_PAGE_SIZE).map(row => {
      const reason = String(row.inventory_change_reason ?? ''), referenceType = String(row.reference_document_type ?? '');
      const identity = String(row.inventory_adjustment_id ?? '');
      if (!identity) throw new DataError('Movement detail is missing an adjustment identifier.');
      const eventKey = JSON.stringify([identity, row.second, reason, referenceType, row.reference_document_uri]);
      if (seen.has(eventKey)) throw new DataError('Duplicate movement details were returned.');
      seen.add(eventKey);
      return {id: identity, minute: String(row.second ?? ''), reason, referenceType, reference: String(row.reference_document_uri ?? ''), delta: quantity(row.inventory_adjustment_change)!, category: classify(reason, referenceType)};
    });
    return {rows: mapped, hasNext: rows.length > DETAIL_PAGE_SIZE, offset};
  }
}
