# CSV export

## Merchant workflow

Use **Export CSV** in the app header. Choose **All matching inventory** or **Current results page**, then **Prepare CSV**.

- All matching inventory uses the report settings shown in the dialog and starts from the beginning of that filtered selection. It is not restricted by the current-page exceptions toggle.
- Current results page uses the last completed page and its original filters. The existing inline page-export link also remains available.
- Small selections produce one complete CSV. Empty selections produce a header-only file.
- Large selections pause between files. Download a part, confirm **I saved this CSV part**, then choose **Prepare next part**.
- The next part replaces the prior download link, so only one file is held in memory.
- Resume progress is scoped to the Shopify shop ID and stored with Shopify extension storage on this device. It contains filters and a cursor, not inventory rows or CSV content.
- Closing during preparation discards the unfinished file. Reopen Export CSV and use **Resume export**. The last unconfirmed part may be prepared again; confirmed rows are not skipped.
- After downloading a final file, **Done** clears the checkpoint. **Discard saved progress** only deletes local resume metadata, never downloaded files or inventory.

Use one export tab per store. Checkpoints are not a distributed job queue or an immutable snapshot. Clearing browser/extension storage removes resume progress.

## Bounded memory and request behavior

Each CSV part stops at the first of these **application safety limits**:

- 5,000 rows;
- 2 MiB of encoded download-URL data;
- 100 source pages;
- approximately four minutes of processing, checked between pages.

These are application guardrails, not asserted Shopify/browser limits. A single row that exceeds the file limit fails instead of being truncated. A page-budget/time boundary produces a clearly marked nonfinal part with a valid continuation cursor.

Export fetches up to 500 positions per window. Each window still uses two ShopifyQL operations. Movements are aggregated on Shopify by item/location/reason/reference type, rather than downloading individual sales. Query responses remain bounded by 501 balance rows and 1,000 movement groups. The existing shared pacing, rate-limit backoff and cancellation apply.

If a file boundary falls inside a fetched page, the cursor points to the last row actually written. The next part re-fetches the unexported remainder. This avoids gaps without retaining unbounded pending pages.

No incomplete part is offered after an API error, invalid cursor, filter mismatch or cancellation. Earlier confirmed downloads remain valid as previously retrieved.

## CSV format

UTF-8 with BOM, comma-separated, CRLF record separators, RFC-style doubled quotes. Embedded commas/newlines are escaped. Potential spreadsheet-formula strings are neutralized, while negative numeric quantities remain numeric. Missing balances remain blank and status columns flag missing data and variances.

Each row includes item/location IDs, report filters/timezone, fetch timestamp, export scope, export ID and part number. Keep the export ID consistent when combining parts; retain one header and one copy of each part. An unconfirmed part can be prepared again after resuming, so do not combine duplicate downloads of that part. For very large combinations, use a data tool rather than assuming a spreadsheet can display every row. Import SKU and ID columns as text in spreadsheet software to preserve leading zeros and long identifiers.

The report exports a reconciliation summary, not every individual movement event.

## Enterprise boundary

This is a user-attended browser export. A one-million-row selection could require hundreds of confirmed file downloads. It does not continue after the app closes, produce a single durable multi-gigabyte file, or guarantee a transactional snapshot across queries.

For a practical **single-file, unattended enterprise export**, add a backend job worker that streams these bounded pages into object storage, persists progress transactionally, handles offline authentication, and supplies a download URL to the same native UI. That worker is **not implemented or deployed** in this project.

## Validation

Unit tests cover complete selection traversal, row/encoded-byte/work-budget limits, Unicode, formulas, missing balances, cancellation, cursor failures and cross-store/timezone resume rejection. Browser tests download and inspect the actual CSV, traverse multiple parts and resume after reload.

`node --expose-gc scripts/benchmark-export.mjs 1000000` processed **1,000,000 synthetic output rows** in **200 bounded parts**, retaining at most 500 input rows per read. See `export-benchmark.json`. The harness automatically acknowledges files; the actual UI requires confirmation. This measures the export core, not Shopify query throughput, live history completeness, browser IPC or download performance.

Bump the checkpoint format version if CSV structure or category semantics become incompatible with an earlier export. Validate actual downloads in the Shopify Admin extension runtime before production use.
