# Live-store release gate

No live-store validation has been performed. Do not present this build as enterprise-certified or use it to sign off inventory accounts yet.

## 1. Installation and access

- Generate a real App Home extension UID with current Shopify CLI. Preserve the generated app identity and UID when integrating this source.
- Run Shopify CLI configuration validation in the linked app.
- Approve only read_reports, read_inventory, read_products and read_locations. Resolve ShopifyQL protected-data requirements.
- Run both discovery queries, category aggregation and detail queries against the development store. Check ID inequality predicates, multiple ORDER BY dimensions, LIMIT/OFFSET, source filters and response shape.
- Verify data-URL CSV downloads in the actual Admin remote DOM runtime, including a file near the 2 MiB encoded-size guardrail. Browser-preview success alone is not proof of runtime support.
- Confirm download/continue/reload/resume behavior on the merchant browser. The saved checkpoint must start after the last confirmed file, never after unfinished data. Validate UTF-8, negative quantities, missing balances, quoted text and formula-safe string fields.
- Confirm the actual Shopify deployment bundle remains under 64 KB compressed. The local esbuild artifact is a preflight estimate, not Shopify CLI's deployment artifact.

## 2. Resolve inventory-state and date semantics

Public documentation uses differing wording around available and on-hand inventory. Do not resolve that by assuming the labels are interchangeable.

Use fixtures with known available, committed, unavailable and incoming quantities. Establish whether the starting/ending location metrics match the available-state deltas for the exact period boundaries and store timezone. If not, change the balance source or movement basis before release.

Only completed days are accepted, but analytics ingestion can still lag. Confirm boundary behavior, DST changes, late-arriving data and newly created items. The fetched-at timestamp is not a source-completeness watermark.

## 3. Reconciliation cases

Record the expected and observed quantities for:

- Unchanged item with stock, zero-stock item, negative stock.
- Sale, sale reversal, order edit and cancellation.
- Refund without restocking; return restocked at a different location.
- Transfer out, transfer in, transfer cancellation and supplier receipt.
- Manual correction, third-party app adjustment and unknown reason.
- Deleted product, renamed/duplicate/blank SKU and inactive/deleted location.
- Movements without an opening/closing balance.
- Item created within the report period.

Category rules are deliberately conservative. Only purchase maps to sold; restock with Refund maps to restocked returns; Inventory::Transfer references map to transfers. Everything else remains Other. Validate and extend these rules with actual reference/reason combinations, never classify from the sign alone.

## 4. Coverage and consistency

- Compare item/location keys against an independent authoritative inventory list for representative locations. Analytics may omit items absent from both datasets.
- Confirm first, middle and last pages, and the transition between locations. Compare a full small-scope export with independently enumerated results.
- Test a movement result cut off inside an item at the 1,000-group limit, more than 50 detail rows and more than 1,000 report positions. Confirm that deferred positions reappear completely on the next page.
- Repeat the same period after delayed changes. The two queries are not a transactional snapshot. Key-boundary checks ensure a position is not partially retrieved but cannot detect upstream omissions or concurrent changes.
- Confirm missing tables, scopes, timeouts and safety limits do not produce zero movements or valid-looking partial totals.

## 5. Enterprise performance

Record, on a representative merchant:

- Catalog size, stocked item/location pairs, changes per day and peak bursts.
- First-page and next-page latency for a day, month and year; all locations versus one location.
- Query complexity failures, timeouts, throttle rate, response sizes and request counts. A normal report page must use exactly two analytics operations, excluding retries and one-time settings loads. Verify the visible waiting state and bounded retries for the actual host rate-limit response.
- Behavior after cancellation, expired permissions and rapid filter changes.
- Deep keyset seeks and exact-SKU lookup latency.

Set an acceptance SLA with the merchant before testing. This project intentionally makes no unmeasured timing guarantee. If server-side analytics cannot meet the SLA, use a cached backend workflow instead of increasing client-side row limits.

## Scope intentionally excluded

This client offers user-attended CSV traversal in bounded parts. It does not claim a single unattended full-catalog download, a global variance count, scheduled delivery, immutable period-end snapshots or complete pre-install historical coverage. A durable export worker remains a separate requirement.
