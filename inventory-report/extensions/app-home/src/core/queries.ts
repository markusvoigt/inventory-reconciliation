import {id, validDate} from './domain.ts';
import {DETAIL_PAGE_SIZE, EXPORT_PAGE_SIZE, MOVEMENT_ROW_LIMIT, PAGE_SIZE} from './types.ts';
import type {Filters, Pair} from './types.ts';

export const ANALYTICS = `query ReconciliationAnalytics($query: String!) {
  shopifyqlQuery(query: $query) {
    parseErrors
    tableData { columns { name dataType } rows }
  }
}`;
export const SHOP = `query ReconciliationShop { shop { id name ianaTimezone } }`;
export const LOCATIONS = `query ReconciliationLocations($after: String) {
  locations(first: 250, after: $after, includeInactive: true) {
    nodes { id name isActive }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function literal(value: string): string {
  if (/[\u0000-\u001f]/.test(value)) throw new Error('Control characters are not allowed in a filter.');
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}
function period(f: Filters): string {
  if (!validDate(f.start) || !validDate(f.end) || f.start > f.end) throw new Error('Invalid report dates.');
  return `SINCE ${f.start} UNTIL ${f.end}`;
}
function where(f: Filters, movements: boolean, after: Pair | null = null, before: Pair | null = null): string {
  const clauses = ['inventory_is_tracked = true'];
  if (movements) clauses.push("inventory_state = 'available'");
  if (f.locationId) clauses.push(`inventory_location_id = ${id(f.locationId)}`);
  if (f.sku) clauses.push(`product_variant_sku = ${literal(f.sku)}`);
  if (after) {
    const loc = id(after.locationId), item = id(after.itemId);
    clauses.push(`(inventory_location_id > ${loc} OR (inventory_location_id = ${loc} AND inventory_item_id > ${item}))`);
  }
  if (before) {
    const loc = id(before.locationId), item = id(before.itemId);
    clauses.push(`(inventory_location_id < ${loc} OR (inventory_location_id = ${loc} AND inventory_item_id < ${item}))`);
  }
  return clauses.join(' AND ');
}

// Query 1: opening/closing balances AND labels. No separate inventory-item fetch.
export function balanceQuery(f: Filters, after: Pair | null, pageSize = PAGE_SIZE): string {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > EXPORT_PAGE_SIZE) throw new Error('Invalid report page size.');
  return `FROM inventory_by_location
SHOW starting_inventory_units_at_location, ending_inventory_units_at_location
WHERE ${where(f, false, after)}
GROUP BY inventory_location_id, inventory_item_id, product_variant_sku, product_title, product_variant_title
${period(f)}
ORDER BY inventory_location_id ASC, inventory_item_id ASC
LIMIT ${pageSize + 1}`;
}

// Query 2: period totals by reason, NOT daily events and NOT one query per SKU.
// Both streams start at the same key. joinWindow defers any position clipped at
// either row limit, so a page only contains positions fully covered by BOTH calls.
export function movementQuery(f: Filters, after: Pair | null, before: Pair | null = null): string {
  return `FROM inventory_adjustment_history
SHOW inventory_adjustment_change
WHERE ${where(f, true, after, before)}
GROUP BY inventory_location_id, inventory_item_id, inventory_change_reason, reference_document_type, product_variant_sku, product_variant_title
${period(f)}
ORDER BY inventory_location_id ASC, inventory_item_id ASC, inventory_change_reason ASC, reference_document_type ASC, product_variant_sku ASC, product_variant_title ASC
LIMIT ${MOVEMENT_ROW_LIMIT}`;
}

export function detailQuery(f: Filters, pair: Pair, offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid detail page.');
  return `FROM inventory_adjustment_history
SHOW inventory_adjustment_change
WHERE ${where({...f, sku: ''}, true)} AND inventory_location_id = ${id(pair.locationId)} AND inventory_item_id = ${id(pair.itemId)}
GROUP BY inventory_adjustment_id, second, inventory_change_reason, reference_document_type, reference_document_uri
${period(f)}
ORDER BY second DESC, inventory_adjustment_id DESC, inventory_change_reason ASC, reference_document_type ASC, reference_document_uri ASC
LIMIT ${DETAIL_PAGE_SIZE + 1} OFFSET ${offset}`;
}
