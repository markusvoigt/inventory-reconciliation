import {useEffect, useRef, useState} from 'preact/hooks';
import {isAborted, message} from '../core/api.ts';
import {createExport, currentPageFile, EXPORT_LIMITS, parseCheckpoint, prepareCsvPart} from '../core/export.ts';
import type {CheckpointStore, CsvPart, ExportCheckpoint, ExportProgress} from '../core/export.ts';
import {validateFilters} from '../core/domain.ts';
import {EXPORT_PAGE_SIZE} from '../core/types.ts';
import type {Context, Filters, Page} from '../core/types.ts';
import type {Reports} from '../core/report.ts';

export type ExportRequest = {revision: number; scope: 'page' | 'selection'};
type Props = {reports: Reports; context: Context; draft: Filters; page: Page | null; pageNumber: number; request: ExportRequest; storage?: CheckpointStore; blocked: boolean; onBusyChange: (busy: boolean) => void};
const number = (n: number) => new Intl.NumberFormat('en').format(n);
const bytes = (n: number) => n < 1024 * 1024 ? `${Math.ceil(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
const emptyProgress = (): ExportProgress => ({rows: 0, pages: 0, csvBytes: 0, encodedBytes: 0});

export function ExportDialog({reports, context, draft, page, pageNumber, request, storage, blocked, onBusyChange}: Props) {
  const modal = useRef<HTMLElementTagNameMap['s-modal']>(null);
  const task = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [scope, setScope] = useState<'page' | 'selection'>('selection');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ExportProgress>(emptyProgress());
  const [activity, setActivity] = useState('');
  const [part, setPart] = useState<CsvPart | null>(null);
  const [saved, setSaved] = useState<ExportCheckpoint | null>(null);
  const [loadingSaved, setLoadingSaved] = useState(!!storage);
  const [invalidSaved, setInvalidSaved] = useState(false);
  const [error, setError] = useState('');
  const [confirmedSaved, setConfirmedSaved] = useState(false);
  const [downloadRequested, setDownloadRequested] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Filters | null>(null);

  function working(value: boolean) { setBusy(value); onBusyChange(value); }
  function cancel() {
    task.current?.abort(); task.current = null; generation.current++;
    working(false); setActivity(''); setPart(null); setConfirmedSaved(false); setDownloadRequested(false);
  }
  useEffect(() => {
    let active = true;
    setLoadingSaved(!!storage);
    if (storage) storage.load(context.shopId).then(raw => {
      if (!active) return;
      setSaved(parseCheckpoint(raw, context)); setInvalidSaved(false);
    }).catch(e => { if (active) { setInvalidSaved(true); setError(message(e)); } }).finally(() => { if (active) setLoadingSaved(false); });
    return () => { active = false; task.current?.abort(); };
  }, [context.shopId, storage, request.revision]);
  useEffect(() => {
    cancel(); setScope(request.scope); setProgress(emptyProgress()); setError(''); setActiveFilters(null);
  }, [request.revision]);
  useEffect(() => () => { task.current?.abort(); }, []);

  async function prepare(job?: ExportCheckpoint) {
    if (task.current || blocked) return;
    const controller = new AbortController(); task.current = controller;
    const version = ++generation.current;
    const current = () => version === generation.current && !controller.signal.aborted;
    working(true); setError(''); setPart(null); setConfirmedSaved(false); setDownloadRequested(false); setProgress(emptyProgress());
    const chosenFilters = job?.filters ?? (scope === 'page' ? page?.filters : draft);
    if (chosenFilters) setActiveFilters({...chosenFilters});
    try {
      if (!job && scope === 'page') {
        if (!page) throw new Error('Run a report before exporting its current page.');
        const ready = currentPageFile(page, pageNumber);
        if (current()) setPart(ready);
        return;
      }
      if (!job && (saved || invalidSaved)) throw new Error('Resume or discard the saved export before starting a new full-selection export.');
      const checkpoint = job ?? createExport(context, {...draft, sku: draft.sku.trim()});
      if (current()) setActiveFilters({...checkpoint.filters});
      // Persist the START of this part. Only advance after explicit saved-file confirmation.
      if (storage) {
        const existing = parseCheckpoint(await storage.load(context.shopId), context);
        if (existing && existing.exportId !== checkpoint.exportId) throw new Error('Another export is saved for this store. Resume or discard it first.');
        if (existing && existing.nextPart > checkpoint.nextPart) throw new Error('Saved progress advanced in another tab. Reopen Export CSV to reload it.');
        await storage.save(checkpoint);
        if (current()) setSaved(checkpoint);
      }
      if (!current()) return;
      const ready = await prepareCsvPart(checkpoint, (after, signal) => reports.page(checkpoint.filters, after, context.locations, signal, text => {
        if (current()) setActivity(text);
      }, EXPORT_PAGE_SIZE), {signal: controller.signal, onProgress: p => { if (current()) setProgress(p); }});
      if (current()) { setPart(ready); setActivity(''); }
    } catch (e) {
      if (current() && !isAborted(e)) setError(message(e) + ' No incomplete file is offered. Previously downloaded parts are not changed.');
    } finally { if (version === generation.current) { task.current = null; working(false); } }
  }
  async function discard() {
    if (busy) return;
    setError(''); working(true);
    try { await storage?.clear(context.shopId); setSaved(null); setInvalidSaved(false); setPart(null); setActiveFilters(null); }
    catch (e) { setError(message(e)); }
    finally { working(false); }
  }
  async function finish() {
    if (busy) return;
    setError(''); working(true);
    try {
      if (part?.scope === 'selection' && !part.hasMore && storage) {
        const existing = parseCheckpoint(await storage.load(context.shopId), context);
        if (existing && (existing.exportId !== part.exportId || existing.nextPart !== part.part)) throw new Error('Export progress changed in another tab. Its progress has not been changed.');
        if (existing) await storage.clear(context.shopId);
        setSaved(null);
      }
      modal.current?.hideOverlay();
    } catch (e) { setError(message(e)); }
    finally { working(false); }
  }

  const selectedFilters = activeFilters ?? (scope === 'page' ? page?.filters : draft);
  const validation = scope === 'selection' ? validateFilters(draft) : !page ? 'Run a report before exporting the current page.' : '';
  const canStart = !busy && !blocked && !loadingSaved && !validation && !(scope === 'selection' && (saved || invalidSaved));
  return <s-modal id="csv-export" heading="Export inventory CSV" size="base" ref={modal} onHide={cancel}>
    <s-stack gap="base">
      {!busy && !part && <s-select label="Export scope" value={scope} onChange={e => { setScope(e.currentTarget.value as 'page' | 'selection'); setActiveFilters(null); setError(''); }}>
        <s-option value="selection">All matching inventory</s-option>
        <s-option value="page" disabled={!page}>Current results page</s-option>
      </s-select>}
      {selectedFilters && <s-text>{selectedFilters.start} to {selectedFilters.end} · {selectedFilters.locationId ? context.locations.find(l => l.id === selectedFilters.locationId)?.name ?? selectedFilters.locationId : 'All locations'}{selectedFilters.sku ? ` · SKU ${selectedFilters.sku}` : ''} · {selectedFilters.timezone}</s-text>}
      {!part && !busy && <s-text color="subdued">{scope === 'selection' ? 'Uses the report settings, including all matching statuses. The current-page exceptions filter does not restrict this export.' : 'Uses the last completed page and its original filters, including rows hidden by the page exceptions filter.'}</s-text>}
      {error && <s-banner tone="critical" heading="Export could not be completed"><s-paragraph>{error}</s-paragraph></s-banner>}
      {!busy && !part && scope === 'selection' && (saved || invalidSaved) && <s-section heading="Saved export progress">
        <s-stack gap="base">
          {saved && <s-paragraph>{number(saved.completedRows)} rows previously confirmed saved. Resume at part {saved.nextPart}, for {saved.filters.start} to {saved.filters.end}{saved.filters.locationId ? `, location ${context.locations.find(l => l.id === saved.filters.locationId)?.name ?? saved.filters.locationId}` : ', all locations'}{saved.filters.sku ? `, SKU ${saved.filters.sku}` : ''}.</s-paragraph>}
          <s-button-group>
            {saved && <s-button slot="primary-action" variant="primary" disabled={blocked} onClick={() => void prepare(saved)}>Resume export</s-button>}
            <s-button slot="secondary-actions" tone="critical" onClick={() => void discard()}>Discard saved progress</s-button>
          </s-button-group>
          <s-text color="subdued">Discarding progress does not delete downloaded files or change inventory.</s-text>
        </s-stack>
      </s-section>}
      {busy && <s-stack gap="base">
        <s-stack direction="inline" alignItems="center" gap="base"><s-spinner /><s-text>{activity || 'Preparing CSV…'}</s-text></s-stack>
        <s-text>{number(progress.rows)} rows prepared · {number(progress.pages)} data pages · {bytes(progress.csvBytes)}</s-text>
        <s-text color="subdued">Keep this app open. Cancelling discards the current unfinished file, not previously downloaded parts.</s-text>
      </s-stack>}
      {part && !busy && <s-stack gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={part.hasMore ? 'info' : 'success'}>{part.scope === 'page' ? 'Current page ready' : part.hasMore ? `Part ${part.part} ready` : part.part === 1 ? 'Selection complete' : 'Final part ready'}</s-badge>
          <s-text>{number(part.rows)} rows · {bytes(part.csvBytes)}</s-text>
        </s-stack>
        {(part.missingBalances > 0 || part.variances > 0) && <s-text color="subdued">This file includes {number(part.missingBalances)} missing-balance rows and {number(part.variances)} rows with variance. These are flagged in the CSV, not dropped.</s-text>}
        <s-link href={part.uri} download={part.filename} onClick={() => setDownloadRequested(true)}>{part.hasMore || part.part > 1 ? `Download CSV part ${part.part}` : 'Download CSV'}</s-link>
        <s-text color="subdued">{part.filename}</s-text>
        {part.scope === 'selection' && <s-text>{part.hasMore ? `More rows remain. ${number(part.completedRowsBefore)} rows were confirmed in earlier parts.` : `${number(part.completedRowsBefore + part.rows)} rows across ${part.part} file(s) for this selection.`}</s-text>}
        {part.hasMore && <>
          <s-checkbox label="I saved this CSV part" checked={confirmedSaved} disabled={!downloadRequested} onChange={e => setConfirmedSaved(e.currentTarget.checked)} />
          <s-text color="subdued">The next part replaces this download link. Confirm the file is saved before continuing.</s-text>
        </>}
      </s-stack>}
      {!part && !busy && validation && <s-text tone="critical">{validation}</s-text>}
      <s-divider />
      {(part?.scope ?? scope) === 'selection' && (!part || part.hasMore) ? <>
        <s-text color="subdued">Files pause at {number(EXPORT_LIMITS.maxRows)} rows, {bytes(EXPORT_LIMITS.maxEncodedBytes)} encoded download size, or a processing budget. {storage ? 'Resume progress is saved on this device.' : 'Resume storage is unavailable; keep this app open.'} Keep the app open while preparing and use one tab.</s-text>
        <s-text color="subdued">A single unattended million-row CSV needs a backend worker. These CSV parts are not an immutable point-in-time snapshot.</s-text>
      </> : <s-text color="subdued">UTF-8 CSV. Import SKU and ID columns as text to preserve leading zeros and long identifiers.</s-text>}
    </s-stack>
    {!busy && !part && <s-button slot="primary-action" variant="primary" disabled={!canStart} onClick={() => void prepare()}>Prepare CSV</s-button>}
    {part?.hasMore && !busy && <s-button slot="primary-action" variant="primary" disabled={!confirmedSaved || !part.next || blocked} onClick={() => part.next && void prepare(part.next)}>Prepare next part</s-button>}
    {part && !part.hasMore && !busy && <s-button slot="primary-action" variant="primary" disabled={!downloadRequested} onClick={() => void finish()}>Done</s-button>}
    <s-button slot="secondary-actions" commandFor="csv-export" command="--hide">{busy ? 'Cancel export' : 'Close'}</s-button>
  </s-modal>;
}
