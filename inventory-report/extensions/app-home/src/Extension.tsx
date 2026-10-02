import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {App} from './components/App.tsx';
import {Api} from './core/api.ts';
import {Reports} from './core/report.ts';
import type {CheckpointStore} from './core/export.ts';
const checkpointKey = (shopId: string) => 'inventory-reconciliation:csv:v1:' + shopId;
const exportStorage: CheckpointStore = {
  load: shopId => shopify.storage.get(checkpointKey(shopId)),
  save: async checkpoint => { await shopify.storage.set(checkpointKey(checkpoint.shopId), checkpoint); },
  clear: async shopId => { await shopify.storage.delete(checkpointKey(shopId)); },
};
const reports = new Reports(new Api((query, options) => shopify.query(query, {...options, version: '2026-07'})));
export default async function extension() { render(<App reports={reports} exportStorage={exportStorage} />, document.body); }
