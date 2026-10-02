/** Synthetic transport only. Virtual catalog: 2,000,000 items × 3 locations.
 * Generates bounded requested rows, never materializes the catalog.
 * This is not a benchmark of Shopify's query engine or history completeness.
 */
import type {GraphqlClient, QlRow, Pair} from '../inventory-report/extensions/app-home/src/core/types.ts';
const START = 1_000_000;
export const VIRTUAL_ITEMS = 2_000_000;
const END = START + VIRTUAL_ITEMS;
const names = ['Central warehouse', 'City store', 'Returns hub'];
const products = ['Cotton crew-neck', 'Canvas tote', 'Merino scarf', 'Everyday socks', 'Linen shirt', 'Wool beanie'];
function hasBalance(item: number) { return item % 23 !== 0; }
function hasMovement(item: number) { return item % 7 !== 0; }
export function syntheticValues(item: number) {
  const opening = 60 + item % 91;
  const sold = hasMovement(item) ? item % 9 + 1 : 0;
  const returned = hasMovement(item) ? item % 3 : 0;
  const transfers = hasMovement(item) && item % 5 === 0 ? 8 : 0;
  const other = hasMovement(item) && item % 11 === 0 ? -2 : 0;
  const variance = item % 17 === 0 ? 2 : 0;
  return {opening, sold, returned, transfers, other, closing: opening - sold + returned + transfers + other + variance};
}
function labels(item: number) { return {product_variant_sku: `SKU-${item}`, product_title: products[item % products.length], product_variant_title: ['Small', 'Medium', 'Large'][item % 3]}; }
function movements(pair: Pair): QlRow[] {
  const item = Number(pair.itemId);
  if (!hasMovement(item)) return [];
  const v = syntheticValues(item), l = labels(item);
  const base = {inventory_item_id: pair.itemId, inventory_location_id: pair.locationId, product_variant_sku: l.product_variant_sku, product_variant_title: l.product_variant_title};
  return [
    {...base, inventory_change_reason: 'purchase', reference_document_type: 'Order', inventory_adjustment_change: -v.sold},
    ...(v.returned ? [{...base, inventory_change_reason: 'restock', reference_document_type: 'Refund', inventory_adjustment_change: v.returned}] : []),
    ...(v.transfers ? [{...base, inventory_change_reason: 'shipment_received', reference_document_type: 'Inventory::Transfer', inventory_adjustment_change: v.transfers}] : []),
    ...(v.other ? [{...base, inventory_change_reason: 'correction', reference_document_type: null, inventory_adjustment_change: v.other}] : []),
  ].sort((a, b) => String(a.inventory_change_reason).localeCompare(String(b.inventory_change_reason)));
}
function result(rows: QlRow[], columns: string[]) { return {shopifyqlQuery: {parseErrors: [], tableData: {columns: columns.map(name => ({name, dataType: 'STRING'})), rows}}}; }
export const syntheticClient: GraphqlClient = async <T>(document: string, options?: {variables?: Record<string, unknown>}) => {
  const variables = options?.variables ?? {};
  let data: unknown;
  if (document.includes('ReconciliationShop')) data = {shop: {id: 'gid://shopify/Shop/1', name: 'Preview store', ianaTimezone: 'Europe/Berlin'}};
  else if (document.includes('ReconciliationLocations')) data = {locations: {nodes: names.map((name, i) => ({id: `gid://shopify/Location/${i + 1}`, name, isActive: true})), pageInfo: {hasNextPage: false, endCursor: null}}};
  else if (document.includes('ReconciliationAnalytics')) {
    const q = String(variables.query ?? '');
    const limit = Number(q.match(/LIMIT (\d+)/)?.[1] ?? 50);
    const offset = Number(q.match(/OFFSET (\d+)/)?.[1] ?? 0);
    const balances = q.startsWith('FROM inventory_by_location');
    const details = q.includes('GROUP BY inventory_adjustment_id');
    const selected = q.match(/WHERE inventory_is_tracked = true(?: AND inventory_state = 'available')? AND inventory_location_id = (\d+)/)?.[1];
    const sku = q.match(/product_variant_sku = '([^']*)'/)?.[1];
    if (details) {
      const locs = [...q.matchAll(/inventory_location_id = (\d+)/g)];
      const pair = {locationId: locs[locs.length - 1]?.[1] ?? '1', itemId: q.match(/inventory_item_id = (\d+)/)?.[1] ?? String(START)};
      const rows = movements(pair).map((r, i) => ({inventory_adjustment_id: String(Number(pair.itemId) * 10 + i), second: `2026-09-15 10:0${i}:00`, inventory_change_reason: r.inventory_change_reason, reference_document_type: r.reference_document_type, reference_document_uri: `gid://shopify/${r.reference_document_type ?? 'InventoryAdjustment'}/${pair.itemId}`, inventory_adjustment_change: r.inventory_adjustment_change})).reverse().slice(offset, offset + limit);
      data = result(rows, ['inventory_adjustment_id', 'second', 'inventory_change_reason', 'reference_document_type', 'reference_document_uri', 'inventory_adjustment_change']);
    } else {
      const cursorLoc = Number(q.match(/inventory_location_id > (\d+)/)?.[1] ?? 0);
      const cursorItem = Number(q.match(/inventory_item_id > (\d+)/)?.[1] ?? 0);
      const beforeLoc = Number(q.match(/inventory_location_id < (\d+)/)?.[1] ?? 0);
      const beforeItem = Number(q.match(/inventory_item_id < (\d+)/)?.[1] ?? 0);
      const rows: QlRow[] = [];
      for (let loc = selected ? Number(selected) : Math.max(1, cursorLoc); loc <= (selected ? Number(selected) : 3); loc++) {
        if (loc < cursorLoc) continue;
        if (beforeLoc && loc > beforeLoc) break;
        let item = loc === cursorLoc ? Math.max(START, cursorItem + 1) : START;
        if (sku) { if (!/^SKU-\d+$/.test(sku)) continue; item = Number(sku.slice(4)); }
        for (; item < END && rows.length < limit; item++) {
          if (beforeLoc === loc && item >= beforeItem) break;
          if (item < START || (loc === cursorLoc && item <= cursorItem)) { if (sku) break; continue; }
          const pair = {itemId: String(item), locationId: String(loc)};
          if (balances && hasBalance(item)) {
            const v = syntheticValues(item);
            rows.push({inventory_location_id: String(loc), inventory_item_id: String(item), ...labels(item), starting_inventory_units_at_location: v.opening, ending_inventory_units_at_location: v.closing});
          } else if (!balances) rows.push(...movements(pair).slice(0, limit - rows.length));
          if (sku) break;
        }
        if (rows.length >= limit) break;
      }
      data = result(rows, ['inventory_location_id', 'inventory_item_id', 'product_variant_sku', 'product_variant_title', ...(balances ? ['product_title', 'starting_inventory_units_at_location', 'ending_inventory_units_at_location'] : ['inventory_change_reason', 'reference_document_type', 'inventory_adjustment_change'])]);
    }
  } else throw new Error('Unexpected operation in the two-query fixture.');
  return {data: data as T};
};
