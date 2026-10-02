import type {Filters, Page, ReportRow} from './types.ts';

export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  // Keep a string well-formed before URI encoding. Shopify labels can be arbitrary text.
  text = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  // Neutralize spreadsheet formulas without changing signed numeric quantities.
  if (typeof value === 'string' && /^[\s]*[=+@-]|^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}
const HEADERS = ['Location', 'SKU', 'Product', 'Variant', 'Inventory item ID', 'Location ID', 'Opening', 'Sold (net)', 'Returns restocked (net)', 'Transfers (net)', 'Adjusted / other', 'Expected closing', 'Reported closing', 'Variance', 'Status', 'Start date', 'End date', 'Timezone', 'Fetched at', 'Export scope', 'Export ID', 'Part'];
export function csvHeader(): string { return '\uFEFF' + HEADERS.map(csvCell).join(','); }
export function csvRow(row: ReportRow, filters: Filters, fetchedAt: string, scope: string, exportId = '', part = 1): string {
  return [row.locationName, row.sku, row.title, row.variant, row.itemId, row.locationId, row.opening, row.sold, row.returns, row.transfers, row.other, row.expected, row.closing, row.variance, row.status, filters.start, filters.end, filters.timezone, fetchedAt, scope, exportId, part].map(csvCell).join(',');
}
export function pageCsv(page: Page): string {
  return [csvHeader(), ...page.rows.map(row => csvRow(row, page.filters, page.fetchedAt, 'Current page only'))].join('\r\n');
}
