export type Cell = string | number | null;
export type QlRow = Record<string, Cell>;
export type GraphqlResult<T> = {data?: T; errors?: {message: string; extensions?: {code?: string}}[]};
export type GraphqlClient = <T>(query: string, options?: {variables?: Record<string, unknown>}) => Promise<GraphqlResult<T>>;
export type Filters = Readonly<{start: string; end: string; locationId: string | null; sku: string; timezone: string}>;
export type Pair = {itemId: string; locationId: string};
export type Balance = Pair & {opening: number | null; closing: number | null};
export type Category = 'sold' | 'returns' | 'transfers' | 'other';
export type Movement = Pair & {reason: string; referenceType: string; delta: number};
export type Amounts = {sold: number; returns: number; transfers: number; other: number};
export type Metadata = {sku: string | null; title: string | null; variant: string | null};
export type ReportRow = Balance & Metadata & Amounts & {
  locationName: string; expected: number | null; variance: number | null;
  status: 'matched' | 'variance' | 'missing';
};
export type Page = {rows: ReportRow[]; after: Pair | null; next: Pair | null; hasNext: boolean; fetchedAt: string; filters: Filters};
export type Detail = {id: string; minute: string; reason: string; referenceType: string; reference: string; delta: number; category: Category};
export type DetailPage = {rows: Detail[]; hasNext: boolean; offset: number};
export type Location = {id: string; name: string; active: boolean};
export type Context = {shopId: string; timezone: string; locations: Location[]; shopName: string};
export const PAGE_SIZE = 50;
export const EXPORT_PAGE_SIZE = 500;
// The last position is deferred if this limit is hit, never partially reconciled.
export const MOVEMENT_ROW_LIMIT = 1000;
export const DETAIL_PAGE_SIZE = 50;
