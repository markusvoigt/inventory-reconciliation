# Architecture and local evidence

## Active source

The source used by Shopify CLI, tests and the local preview is `inventory-report/extensions/app-home/src/`. App Home target: `admin.app.home.render`, API version 2026-07. Polaris components only. No backend or AI in the execution path.

## Two-query report path

1. On app startup, read store timezone and location names once. This setup is separate from running a report.
2. Query `inventory_by_location` for up to 51 opening/closing balance rows when browsing, or 501 during CSV traversal, including SKU/product labels and ordered by location/item ID.
3. Query `inventory_adjustment_history` once for up to 1,000 available-state movement groups, by item/location/reason/reference type. Apply the same period, location, SKU and lower key boundary. If the balance query has a lookahead row, use its key as an exclusive upper boundary.
4. Join in the client. If a source hits its limit, its final position might be incomplete; exclude that position and everything later from this page. Render the first 50 positions covered by both sources, including unchanged balances and movement-only positions.
5. Next page starts strictly after the last published position. Deferred positions are fetched again from the start, so their totals cannot be split or lost between pages. A single position that fills the entire bounded movement buffer fails closed.
6. Fetch movement details only when opened. The detail query contains adjustment IDs and timestamps, not just aggregate rows.

The success path uses exactly **two analytics operations per report page**. There are no per-SKU batches, separate discovery requests, product metadata requests, or duplicate movement checksum queries. Retries are additional attempts.

## Rate-limit handling

- One host call in flight across settings, reports, details and retries.
- Request starts are at least 300 ms apart.
- Recognize THROTTLED/RATE_LIMITED codes, HTTP 429, message-only GraphQL errors, thrown host errors, and rate-limit messages in analytics errors.
- Up to three retries with 1.5/3/6-second base backoff plus jitter.
- Honor Retry-After when exposed; retain the cooldown for a subsequent manual Run.
- Never retry permission/schema errors or a mixture of rate-limit and nonretryable GraphQL errors.
- Display retry progress. Cancellation stops further requests and stale state commits. Physical host calls cannot be cancelled; their concurrency slot remains held until they settle.

## Correctness boundaries

- All displayed positions are complete relative to the bounded results. Analytics can still omit historical catalog items entirely.
- Queries are not a transactional snapshot; a refresh may be required after delayed source updates. The former extra checksum query was removed rather than falsely claiming transaction consistency.
- Category rules remain conservative and signed. Unknown reasons are retained under Other.
- Null/malformed movements fail, rather than becoming zero. Explicitly empty tables are valid; missing/null tables remain errors.
- Identifiers remain strings and use BigInt comparisons. Quantities and sums must be safe integers.
- The page CSV link and exception counts cover the displayed page only. The Export CSV dialog can traverse the full filtered selection in bounded, user-confirmed parts. See CSV-EXPORT.md.

## Local evidence: 2 October 2026

The test suite asserts exactly two analytics calls for both a single-SKU scope and a virtual two-million-item catalog. It exercises independent stream limits, truncated groups, sparse locations, unchanged and movement-only items, deep keyset seeks, rate-limit retry forms, permission failures, cancellation, timezone/DST and CSV safety. Browser tests use actual Polaris components and verify the request count and visible retry state.

The updated synthetic benchmark browsed 100 pages plus a final seek with **202 calls**, down from **804** in the previous implementation. Buffers remained bounded. See `synthetic-benchmark.json`.

**These are synthetic client tests, not measurements of Shopify query latency or real merchant completeness.** The fixture generates requested rows in memory. Do not use its millisecond timings as an enterprise performance claim.

## CSV export validation

The CSV engine traversed 1,000,000 synthetic rows in 200 parts, with at most 500 input rows per read and each encoded download below 2 MiB. Browser tests downloaded actual CSV files and verified complete selections, part boundaries, resume after reload, cancellation, and failures after a successful source page. The checkpoint stores only filters, store identity and a cursor. It advances only when the user confirms a saved part and continues.

This is user-attended export, not a background worker. A practical single unattended million-row file still requires an external job/streaming-download service, which is not included. See export-benchmark.json for the synthetic test methodology and limitations.

## Release gate

This shareable source contains no app/extension identity. Integrate it into a merchant-owned CLI scaffold as described in README.md. Execute LIVE-VALIDATION.md against a representative merchant before financial or enterprise sign-off.
