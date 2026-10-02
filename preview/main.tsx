import {render} from 'preact';
import {App} from '../inventory-report/extensions/app-home/src/components/App.tsx';
import {Api} from '../inventory-report/extensions/app-home/src/core/api.ts';
import {Reports} from '../inventory-report/extensions/app-home/src/core/report.ts';
import {syntheticClient} from './synthetic.ts';
import type {GraphqlClient} from '../inventory-report/extensions/app-home/src/core/types.ts';
import type {CheckpointStore} from '../inventory-report/extensions/app-home/src/core/export.ts';
const checkpointKey = (shopId: string) => 'inventory-reconciliation:preview:csv:' + shopId;
const exportStorage: CheckpointStore = {
  load: async shopId => JSON.parse(localStorage.getItem(checkpointKey(shopId)) ?? 'null'),
  save: async checkpoint => { localStorage.setItem(checkpointKey(checkpoint.shopId), JSON.stringify(checkpoint)); },
  clear: async shopId => { localStorage.removeItem(checkpointKey(shopId)); },
};
declare global { interface Window { reconciliationPreviewCalls: string[]; } }
window.reconciliationPreviewCalls = [];
let limitedOnce = false;
const scenario = new URLSearchParams(location.search).get('scenario');
const client: GraphqlClient = async <T,>(query: string, options?: {variables?: Record<string, unknown>}) => {
  const ql = String(options?.variables?.query ?? '');
  if (ql) window.reconciliationPreviewCalls.push(ql);
  if (scenario === 'rate-once' && ql && !limitedOnce) {
    limitedOnce = true;
    throw new Error('Rate limited. Please retry later.');
  }
  if (scenario === 'export-error' && ql.includes('inventory_item_id >')) return {errors: [{message: 'Synthetic export failure after first page'}]};
  if (scenario === 'empty-analytics' && ql) {
    return {data: {shopifyqlQuery: {parseErrors: [], tableData: {columns: [], rows: []}}} as T};
  }
  if (scenario === 'unexpected-schema' && ql) {
    return {data: {shopifyqlQuery: {parseErrors: [], tableData: {columns: [{name: 'unexpected_metric'}], rows: [{unexpected_metric: 42}]}}} as T};
  }
  if (scenario === 'slow' && ql) await new Promise(resolve => setTimeout(resolve, 250));
  if (scenario === 'movement-error' && ql.includes('AND inventory_location_id = 2') && ql.includes('GROUP BY inventory_location_id, inventory_item_id, inventory_change_reason')) {
    return {errors: [{message: 'Synthetic movement access failure'}]};
  }
  return syntheticClient<T>(query, options);
};
const policy = scenario?.startsWith('export-') ? {minIntervalMs: 0, retryBaseMs: 0, jitter: 0} : {};
const reports = new Reports(new Api(client, 30_000, policy));
render(<App reports={reports} demo exportStorage={exportStorage} />, document.body);
