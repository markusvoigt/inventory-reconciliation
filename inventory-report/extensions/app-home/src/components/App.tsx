import {useEffect, useMemo, useRef, useState} from 'preact/hooks';
import {isAborted, message} from '../core/api.ts';
import {pageCsv} from '../core/csv.ts';
import {add, isoToday, key, sameFilters, shiftDate, validateFilters} from '../core/domain.ts';
import {DETAIL_PAGE_SIZE} from '../core/types.ts';
import type {Context, DetailPage, Filters, Page, Pair, ReportRow} from '../core/types.ts';
import type {Reports} from '../core/report.ts';
import {ExportDialog} from './ExportDialog.tsx';
import type {ExportRequest} from './ExportDialog.tsx';
import type {CheckpointStore} from '../core/export.ts';

const numbers = new Intl.NumberFormat('en');
const format = (value: number | null) => value === null ? 'Missing' : numbers.format(value);
const signed = (value: number) => value > 0 ? '+' + numbers.format(value) : numbers.format(value);
const labels = {sold: 'Sold', returns: 'Returns restocked', transfers: 'Transfers', other: 'Adjusted / other'};

type Props = {reports: Reports; demo?: boolean; exportStorage?: CheckpointStore};
export function App({reports, demo = false, exportStorage}: Props) {
  const [context, setContext] = useState<Context | null>(null);
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const [draft, setDraft] = useState<Filters | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [cursors, setCursors] = useState<(Pair | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const exportActive = useRef(false);
  const [exportRequest, setExportRequest] = useState<ExportRequest>({revision: 0, scope: 'selection'});
  const locked = busy || exportBusy;
  function exportWorking(value: boolean) { exportActive.current = value; setExportBusy(value); }
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const reportTask = useRef<AbortController | null>(null);
  const reportGeneration = useRef(0);
  const [selected, setSelected] = useState<ReportRow | null>(null);
  const [detail, setDetail] = useState<DetailPage | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  const detailTask = useRef<AbortController | null>(null);
  const detailGeneration = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    setContextError('');
    reports.context(controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const end = shiftDate(isoToday(value.timezone), -1);
      setContext(value);
      setDraft({start: shiftDate(end, -29), end, locationId: null, sku: '', timezone: value.timezone});
    }).catch(e => { if (!isAborted(e)) setContextError(message(e)); });
    return () => controller.abort();
  }, [reports, contextAttempt]);
  useEffect(() => () => { reportTask.current?.abort(); detailTask.current?.abort(); }, []);

  const update = (change: Partial<Filters>) => setDraft(current => current ? {...current, ...change} : current);
  const validation = draft ? validateFilters(draft) : '';
  const changed = !!(page && draft && !sameFilters(page.filters, draft));
  const shownRows = useMemo(() => !page ? [] : differencesOnly ? page.rows.filter(r => r.status !== 'matched') : page.rows, [page, differencesOnly]);
  const summary = useMemo(() => {
    const rows = page?.rows ?? [];
    const complete = rows.filter(r => r.status !== 'missing');
    try {
      return {matched: rows.filter(r => r.status === 'matched').length, different: rows.filter(r => r.status === 'variance').length, missing: rows.filter(r => r.status === 'missing').length, opening: complete.reduce((n, r) => add(n, r.opening!), 0), closing: complete.reduce((n, r) => add(n, r.closing!), 0)};
    } catch { return null; }
  }, [page]);
  const csv = useMemo(() => page?.rows.length ? 'data:text/csv;charset=utf-8,' + encodeURIComponent(pageCsv(page)) : '', [page]);

  async function load(filters: Filters, after: Pair | null, index: number, fresh: boolean) {
    if (!context || exportActive.current) return;
    reportTask.current?.abort();
    detailTask.current?.abort();
    detailGeneration.current++;
    const generation = ++reportGeneration.current;
    const controller = new AbortController(); reportTask.current = controller;
    setBusy(true); setError(''); setProgress('Starting report…');
    try {
      const next = await reports.page(filters, after, context.locations, controller.signal, text => {
        if (generation === reportGeneration.current) setProgress(text);
      });
      if (controller.signal.aborted || generation !== reportGeneration.current) return;
      // Commit balances, movements, filters and export atomically.
      setPage(next); setPageIndex(index); setSelected(null); setDetail(null);
      setCursors(old => fresh ? [null] : [...old.slice(0, index), after]);
      if (fresh) setDifferencesOnly(false);
    } catch (e) {
      if (!isAborted(e) && generation === reportGeneration.current) setError(message(e));
    } finally {
      if (generation === reportGeneration.current) { setBusy(false); setProgress(''); }
    }
  }
  function run() { if (draft && !validation) void load({...draft, sku: draft.sku.trim()}, null, 0, true); }
  function cancelReport() { reportTask.current?.abort(); reportGeneration.current++; setBusy(false); setProgress(''); }
  async function loadDetails(row: ReportRow, offset: number) {
    if (!page || exportActive.current) return;
    detailTask.current?.abort();
    const controller = new AbortController(); detailTask.current = controller;
    const generation = ++detailGeneration.current;
    setSelected(row); setDetail(null); setDetailBusy(true); setDetailError('');
    try {
      const result = await reports.details(page.filters, row, offset, controller.signal);
      if (!controller.signal.aborted && generation === detailGeneration.current) setDetail(result);
    } catch (e) {
      if (!isAborted(e) && generation === detailGeneration.current) setDetailError(message(e));
    } finally { if (generation === detailGeneration.current) setDetailBusy(false); }
  }
  function closeDetails() { detailTask.current?.abort(); detailGeneration.current++; setDetailBusy(false); }

  if (!context || !draft) return <s-page heading="Inventory reconciliation" inlineSize="large">
    <s-section>
      {contextError ? <s-stack gap="base">
        <s-banner tone="critical" heading="Could not connect to Shopify"><s-paragraph>{contextError}</s-paragraph></s-banner>
        <s-button onClick={() => setContextAttempt(n => n + 1)}>Retry connection</s-button>
      </s-stack> : <s-stack direction="inline" gap="base" alignItems="center"><s-spinner /><s-text>Loading store settings…</s-text></s-stack>}
    </s-section>
  </s-page>;

  return <s-page heading="Inventory reconciliation" inlineSize="large">
    <s-button slot="primary-action" variant="primary" onClick={run} disabled={!!validation || locked} loading={busy}>Run report</s-button>
    <s-button slot="secondary-actions" commandFor="csv-export" command="--show" onClick={() => setExportRequest(r => ({revision: r.revision + 1, scope: 'selection'}))} disabled={locked || detailBusy}>Export CSV</s-button>
    {demo && <s-banner tone="info" heading="Local preview"><s-paragraph>Synthetic test data. No Shopify store is connected.</s-paragraph></s-banner>}
    <s-section heading="Report settings">
      <s-stack gap="base">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
          <s-date-field label="Start date" value={draft.start} onChange={e => update({start: e.currentTarget.value})} disabled={locked} />
          <s-date-field label="End date" value={draft.end} onChange={e => update({end: e.currentTarget.value})} disabled={locked} />
          <s-select label="Inventory location" value={draft.locationId ?? 'all'} onChange={e => update({locationId: e.currentTarget.value === 'all' ? null : e.currentTarget.value})} disabled={locked}>
            <s-option value="all">All locations</s-option>
            {context.locations.map(location => <s-option key={location.id} value={location.id}>{location.name}{location.active ? '' : ' (inactive)'}</s-option>)}
          </s-select>
          <s-text-field label="Exact SKU" placeholder="All SKUs" value={draft.sku} onChange={e => update({sku: e.currentTarget.value})} disabled={locked} />
        </s-grid>
        <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
          <s-text color="subdued">Available-state movements · {context.timezone} · Completed days only</s-text>
          <s-link commandFor="report-definitions" command="--show">Definitions and coverage</s-link>
        </s-stack>
        {validation && <s-text tone="critical">{validation}</s-text>}
        {changed && !busy && <s-text color="subdued">Filters changed. Run the report to apply them.</s-text>}
      </s-stack>
    </s-section>
    {error && <s-banner tone="critical" heading="Report could not be completed">
      <s-paragraph>{error} {page ? 'The previous completed page is still shown below with its original filters.' : 'No partial totals or variances are shown.'}</s-paragraph>
    </s-banner>}
    {busy && <s-section><s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
      <s-stack direction="inline" gap="base" alignItems="center"><s-spinner /><s-text>{progress}</s-text></s-stack>
      <s-button onClick={cancelReport}>Cancel</s-button>
    </s-stack></s-section>}

    <s-section heading={page ? 'Inventory by location and item' : 'Your reconciliation'} padding="none">
      <s-box padding="base">
        <s-stack gap="base">
          {page ? <>
            <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-text>{page.filters.start} to {page.filters.end} · {page.filters.locationId ? context.locations.find(l => l.id === page.filters.locationId)?.name ?? page.filters.locationId : 'All locations'}{page.filters.sku ? ' · SKU ' + page.filters.sku : ''}</s-text>
              {csv && !locked && <s-link href={csv} download={`inventory-reconciliation-${page.filters.start}-${page.filters.end}-page-${pageIndex + 1}.csv`}>Export this page</s-link>}
            </s-stack>
            {summary && page.rows.length > 0 && <s-stack direction="inline" gap="base" alignItems="center">
              <s-text type="strong">{page.rows.length} positions on this page</s-text>
              <s-badge tone="success">{summary.matched} no difference</s-badge>
              {summary.different > 0 && <s-badge tone="warning">{summary.different} with variance</s-badge>}
              {summary.missing > 0 && <s-badge tone="warning">{summary.missing} missing balances</s-badge>}
            </s-stack>}
            {page.rows.length > 0 && <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
              <s-checkbox label="Only exceptions on this page" checked={differencesOnly} onChange={e => setDifferencesOnly(e.currentTarget.checked)} disabled={locked} />
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-text color="subdued">Page {pageIndex + 1} · Fetched {new Intl.DateTimeFormat('en', {timeZone: context.timezone, hour: '2-digit', minute: '2-digit'}).format(new Date(page.fetchedAt))}</s-text>
                <s-button-group accessibilityLabel="Report pages">
                  <s-button slot="secondary-actions" disabled={locked || pageIndex === 0} onClick={() => void load(page.filters, cursors[pageIndex - 1] ?? null, pageIndex - 1, false)}>Previous</s-button>
                  <s-button slot="secondary-actions" disabled={locked || !page.hasNext} onClick={() => void load(page.filters, page.next, pageIndex + 1, false)}>Next</s-button>
                </s-button-group>
              </s-stack>
            </s-stack>}
          </> : <s-stack gap="small">
            <s-heading>See what changed, and what does not add up.</s-heading>
            <s-paragraph>Choose a completed period and run the report. Opening and closing balances are compared with sales, restocked returns, transfers and other inventory changes.</s-paragraph>
            <s-text color="subdued">Results load up to 50 positions at a time, using two Analytics queries per page. Movement detail loads only when you open an item.</s-text>
          </s-stack>}
        </s-stack>
      </s-box>
      {page && page.rows.length === 0 && <s-box padding="base"><s-paragraph>No inventory positions were returned by Analytics for this selection. This does not certify that the catalog has no stock. Try another location or period.</s-paragraph></s-box>}
      {page && page.rows.length > 0 && <>
        {shownRows.length === 0 ? <s-box padding="base"><s-paragraph>No exceptions on this page. Other pages have not been checked.</s-paragraph></s-box> :
          <s-table loading={busy}>
            <s-table-header-row>
              <s-table-header listSlot="primary">Item</s-table-header>
              <s-table-header listSlot="secondary">Location</s-table-header>
              <s-table-header format="numeric">Opening</s-table-header>
              <s-table-header format="numeric">Sold</s-table-header>
              <s-table-header format="numeric">Restocked</s-table-header>
              <s-table-header format="numeric">Transfers</s-table-header>
              <s-table-header format="numeric">Other ±</s-table-header>
              <s-table-header format="numeric">Closing</s-table-header>
              <s-table-header format="numeric">Variance</s-table-header>
              <s-table-header>Details</s-table-header>
            </s-table-header-row>
            <s-table-body>{shownRows.map(row => <s-table-row key={key(row)}>
              <s-table-cell><s-stack gap="small-300">
                <s-text type="strong">{row.sku || 'Item ' + row.itemId}</s-text>
                <s-text color="subdued">{row.title || 'Product title unavailable'}{row.variant && row.variant !== 'Default Title' ? ' · ' + row.variant : ''}</s-text>
              </s-stack></s-table-cell>
              <s-table-cell>{row.locationName}</s-table-cell>
              <s-table-cell>{row.opening === null ? <s-badge tone="warning">Missing</s-badge> : format(row.opening)}</s-table-cell>
              <s-table-cell>{format(row.sold)}</s-table-cell>
              <s-table-cell>{format(row.returns)}</s-table-cell>
              <s-table-cell>{signed(row.transfers)}</s-table-cell>
              <s-table-cell>{signed(row.other)}</s-table-cell>
              <s-table-cell>{row.closing === null ? <s-badge tone="warning">Missing</s-badge> : format(row.closing)}</s-table-cell>
              <s-table-cell>{row.variance === null ? <s-text color="subdued">Not calculated</s-text> : row.variance === 0 ? <s-text color="subdued">0</s-text> : <s-text tone="critical" type="strong">{signed(row.variance)}</s-text>}</s-table-cell>
              <s-table-cell><s-button accessibilityLabel={`View movements for ${row.sku || row.itemId} at ${row.locationName}`} commandFor="movement-details" command="--show" onClick={() => void loadDetails(row, 0)} disabled={locked}>View</s-button></s-table-cell>
            </s-table-row>)}</s-table-body>
          </s-table>}
        <s-box padding="base"><s-stack gap="base">
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-text color="subdued">{summary ? `Page balances: ${format(summary.opening)} opening · ${format(summary.closing)} closing. Missing balances excluded.` : 'Page totals exceed numeric precision and are not shown.'}</s-text>

          </s-stack>
          <s-text color="subdued">Page totals and “Export this page” cover this page only. Use Export CSV for all matching rows. Variance is a comparison, not a confirmed stock loss. Product labels come from Analytics.</s-text>
        </s-stack></s-box>
      </>}
    </s-section>

    <s-modal id="movement-details" heading="Inventory movements" size="large" onHide={closeDetails}>
      <s-stack gap="base">
        {selected && <s-stack gap="small"><s-heading>{selected.sku || 'Item ' + selected.itemId}</s-heading><s-text color="subdued">{selected.title ?? 'Product title unavailable'} · {selected.locationName}</s-text>
          <s-text>Opening {format(selected.opening)} · Expected closing {format(selected.expected)} · Reported closing {format(selected.closing)}</s-text>
        </s-stack>}
        <s-text color="subdued">Available-state adjustments only. Returns and transfers retain their signs; reversals are not counted twice.</s-text>
        {detailBusy && <s-stack direction="inline" alignItems="center" gap="base"><s-spinner /><s-text>Loading movements…</s-text></s-stack>}
        {detailError && <s-banner tone="critical" heading="Movement detail unavailable"><s-paragraph>{detailError}</s-paragraph></s-banner>}
        {!detailBusy && detail && detail.rows.length === 0 && <s-paragraph>No available-state adjustments were returned for this item and period.</s-paragraph>}
        {!detailBusy && detail && detail.rows.length > 0 && <s-table paginate hasNextPage={detail.hasNext} hasPreviousPage={detail.offset > 0} onNextPage={() => selected && void loadDetails(selected, detail.offset + DETAIL_PAGE_SIZE)} onPreviousPage={() => selected && void loadDetails(selected, Math.max(0, detail.offset - DETAIL_PAGE_SIZE))}>
          <s-table-header-row><s-table-header listSlot="primary">Time</s-table-header><s-table-header>Reason</s-table-header><s-table-header>Category</s-table-header><s-table-header format="numeric">Change</s-table-header><s-table-header>Reference</s-table-header></s-table-header-row>
          <s-table-body>{detail.rows.map((event, i) => <s-table-row key={event.id + ':' + i}>
            <s-table-cell><s-stack gap="small-300"><s-text>{event.minute}</s-text><s-text color="subdued">Adjustment {event.id}</s-text></s-stack></s-table-cell>
            <s-table-cell>{event.reason || 'Unspecified'}</s-table-cell><s-table-cell>{labels[event.category]}</s-table-cell><s-table-cell>{signed(event.delta)}</s-table-cell>
            <s-table-cell><s-stack gap="small-300"><s-text>{event.referenceType || 'No type'}</s-text><s-text color="subdued">{event.reference || 'No reference'}</s-text></s-stack></s-table-cell>
          </s-table-row>)}</s-table-body>
        </s-table>}
      </s-stack>
      <s-button slot="secondary-actions" commandFor="movement-details" command="--hide">Close</s-button>
    </s-modal>

    <ExportDialog reports={reports} context={context} draft={draft} page={page} pageNumber={pageIndex + 1} request={exportRequest} storage={exportStorage} blocked={busy || detailBusy} onBusyChange={exportWorking} />

    <s-modal id="report-definitions" heading="Definitions and coverage" size="base">
      <s-stack gap="base">
        <s-heading>Reconciliation</s-heading>
        <s-paragraph>Expected closing = Opening − Sold + Restocked returns + Transfers + Other. Variance = Reported closing − Expected closing.</s-paragraph>
        <s-paragraph>Movements use the available state only. Balances use Shopify’s starting and ending inventory units at location metrics. Verify their state and period-boundary semantics on your store before financial sign-off. This is not a physical stock count.</s-paragraph>
        <s-heading>Movement categories</s-heading>
        <s-unordered-list>
          <s-list-item>Sold: purchase reason, shown as net units deducted. Reversals reduce this figure.</s-list-item>
          <s-list-item>Restocked: restock reason with a Refund reference. Other return workflows remain in Other until a verified mapping is added.</s-list-item>
          <s-list-item>Transfers: Inventory::Transfer references, shown as signed net change.</s-list-item>
          <s-list-item>Other: every remaining change, including receipts and manual adjustments. Actual reasons and references remain available in the detail view.</s-list-item>
        </s-unordered-list>
        <s-heading>Coverage and freshness</s-heading>
        <s-paragraph>The report includes tracked item/location pairs present in either analytics dataset, including balance rows with no movements and movement rows with no balances. It cannot certify catalog items absent from both datasets or restore history Shopify no longer exposes.</s-paragraph>
        <s-paragraph>Only completed store-local days are accepted. Analytics can still arrive late. Separate queries are not a transactional snapshot. Both queries use the same period and key range. A position cut off at a row limit is deferred to the next page, never partially reconciled. Missing data and query errors never become zero.</s-paragraph>
        <s-paragraph>Product names and SKUs come from Shopify Analytics, without additional per-item API calls. Exact-SKU filtering uses the same analytics dimension. For a renamed SKU, remove the filter and identify the item by its stable ID.</s-paragraph>
        <s-heading>Large catalogs</s-heading>
        <s-paragraph>Browsing is paginated by stable location and item IDs. CSV export can traverse the filtered report in bounded, resumable parts without loading the catalog into memory. It pauses for a confirmed download between parts. A single unattended million-row file, scheduled delivery and durable background jobs require a backend worker.</s-paragraph>
      </s-stack>
      <s-button slot="secondary-actions" commandFor="report-definitions" command="--hide">Close</s-button>
    </s-modal>
  </s-page>;
}
