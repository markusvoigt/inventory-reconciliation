# Shopify inventory reconciliation

A read-only custom Shopify Admin app that brings inventory balances and adjustment history into one report by inventory item and location. Built entirely with native Polaris components as a Shopify-hosted App Home UI extension. No app backend is required for browsing or user-attended CSV exports.

**This is a custom reference implementation, not a native Shopify report or a production-certified enterprise reporting service.** Validate quantities, classification rules, historical coverage and performance on your store before production or financial use.

## Features

- Opening and closing balances, net units sold, restocked returns, signed transfers, other adjustments and variance.
- Completed-day date ranges, inventory-location filters and exact-SKU lookup.
- Two ShopifyQL operations per successful retrieval window, joined client-side using item/location IDs. No query per SKU.
- Bounded pagination, on-demand adjustment detail, request pacing, rate-limit retries and cancellation.
- Current-page CSV or all matching inventory in resumable parts. Missing balances stay flagged, never silently become zero.
- Native Polaris UI only. No custom design system, external data service or AI in the reporting path.

## Local preview and tests

Requirements: Node.js 22.18+ and npm.

```sh
npm ci
npm run check
npm run preview
```

Open http://127.0.0.1:4317. The preview uses explicitly labelled synthetic data and does not connect to a Shopify store.

For browser tests, install a Playwright Chromium browser if needed, then run `npm run test:ui`. `PLAYWRIGHT_EXECUTABLE_PATH` can point to an existing dedicated test browser.

## Install in a development store

The Shopify-hosted App Home extension route requires **custom distribution** and a user with app development permissions. You will need appropriate Shopify Analytics/API access; `shopifyqlQuery` also documents protected-customer-data access requirements.

1. Outside this repository, run `shopify app init` with an up-to-date Shopify CLI. Select **Build an extension-only app**. This generates your app identity and extension UID.
2. Replace the generated App Home extension's `src/` directory with `inventory-report/extensions/app-home/src/` from this repository. Preserve the generated extension UID and app identity.
3. Set the extension target to `admin.app.home.render`, its module to `./src/Extension.tsx`, and its API version to `2026-07`. Use the supplied extension TOML as a reference, not as a replacement for your generated UID. Remove unused sample FAQ extensions from the new scaffold.
4. Use the dependency versions in `inventory-report/extensions/app-home/package.json`. Merge the direct-API and read-scope settings from `inventory-report/shopify.app.toml.example` into your generated configuration. Do not retain the FAQ sample's write scopes or metadata definitions.
5. In your generated app, run:

```sh
shopify app config validate --json
shopify app dev --store <your-development-store>.myshopify.com --no-update
```

6. Open the CLI preview, approve the required permissions and complete [live validation](docs/LIVE-VALIDATION.md). Only then consider `shopify app deploy` for your linked app.

Required read-only scopes: `read_reports,read_inventory,read_products,read_locations`.

No app IDs, extension UIDs, store domains, credentials or merchant inventory data are included in this repository. Each merchant must create its own app configuration.

## Inventory semantics

- Movements use the **available** inventory state. Validate that the opening/closing metrics use the matching basis and period boundaries on your store. This is not a physical stock count.
- Sold uses the purchase reason. Restocked returns use restock with a Refund reference. Transfers use Inventory::Transfer references. Unmapped workflows remain visible in Other. Validate these rules against your actual operations.
- Refunds without restocking are not positive inventory movements. Receipts, cancellations, transfers and manual adjustments must remain included for reconciliation.
- The report retains unchanged balance rows and movement rows with missing balances. It cannot recover items or history that neither Analytics dataset exposes.
- Separate queries are not an immutable point-in-time snapshot. Analytics can arrive late; deleted or untracked records and historical limits affect coverage.

## High-volume behavior and CSV exports

Browser work is bounded. Browsing retrieves up to 50 positions per window; CSV traversal retrieves up to 500. Movement summaries return at most 1,000 grouped rows. A position clipped at a row limit is deferred, not partially reconciled.

CSV parts pause at the first of 5,000 rows, 2 MiB encoded download size, or a processing budget. Download and confirm each part before continuing. A small, store-scoped checkpoint supports resume on the same device. The app does not keep millions of rows in memory.

**A single unattended million-row CSV, scheduled export or durable background job requires an additional backend worker. That worker is not included.** A million-row browser export can require hundreds of user-confirmed parts.

The test harness exercises a virtual two-million-item catalog and a one-million-row CSV traversal. These are synthetic client tests, not proof of live Shopify throughput or production accounting accuracy.

See [CSV behavior](docs/CSV-EXPORT.md), [engineering notes](docs/ENGINEERING.md) and [live validation](docs/LIVE-VALIDATION.md).

## Source layout

- `inventory-report/extensions/app-home/src/Extension.tsx`: entry point.
- `components/`: Polaris report and export interfaces.
- `core/`: queries, response validation, join, reconciliation, CSV and export traversal.
- `tests/`: core and browser regression tests.
- `preview/`: synthetic local preview, excluded from the production bundle.

## Shopify documentation

- [Custom inventory adjustment reports](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/custom-reports/inventory-adjustment-reports)
- [Inventory balance schema](https://shopify.dev/docs/api/shopifyql/latest/schemas/inventory/inventory_by_location)
- [Inventory adjustment schema](https://shopify.dev/docs/api/shopifyql/latest/schemas/inventory/inventory_adjustment_history)
- [App Home UI extensions](https://shopify.dev/docs/apps/build/app-home/app-home-ui-extensions)
- [ShopifyQL access requirements](https://shopify.dev/docs/api/admin-graphql/latest/queries/shopifyqlQuery)
