import {test, expect} from '@playwright/test';

test('native report: run, paginate, inspect movements, filter and export', async ({page}) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Run report', exact: true})).toBeVisible();
  await expect(page.getByText('Synthetic test data. No Shopify store is connected.')).toBeVisible();
  await page.getByRole('button', {name: 'Run report', exact: true}).click();
  await expect(page.getByText('50 positions on this page')).toBeVisible();
  await expect(page.getByRole('link', {name: 'Export this page'})).toBeVisible();
  expect(await page.evaluate(() => window.reconciliationPreviewCalls.length)).toBe(2);
  const first = await page.locator('s-table-row').first().textContent();
  await page.getByRole('button', {name: 'Next', exact: true}).click();
  await expect(page.getByText(/Page 2 · Fetched/)).toBeVisible();
  expect(await page.evaluate(() => window.reconciliationPreviewCalls.length)).toBe(4);
  expect(await page.locator('s-table-row').first().textContent()).not.toBe(first);
  await page.getByRole('button', {name: 'Previous', exact: true}).click();
  await expect(page.getByText(/Page 1 · Fetched/)).toBeVisible();
  await page.getByRole('button', {name: /View movements for/}).first().click();
  await expect(page.getByRole('dialog', {name: 'Inventory movements'})).toBeVisible();
  await expect(page.locator('#movement-details').getByText(/Adjustment /).first()).toBeVisible();
  await page.locator('#movement-details s-button[slot="secondary-actions"]').getByRole('button', {name: 'Close', exact: true}).click();
  await page.getByRole('checkbox', {name: 'Only exceptions on this page'}).check();
  expect(await page.locator('s-table-row').count()).toBeLessThan(50);
  await page.getByRole('checkbox', {name: 'Only exceptions on this page'}).uncheck();
  const csv = await page.getByRole('link', {name: 'Export this page'}).getAttribute('href');
  expect(decodeURIComponent(csv!)).toContain('Current page only');
  await page.screenshot({path: 'test-results/native-report.png', fullPage: true});
  expect(errors).toEqual([]);
});

test('draft filters do not relabel existing results', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Run report', exact: true}).click();
  await expect(page.getByText('50 positions on this page')).toBeVisible();
  const previousExport = await page.getByRole('link', {name: 'Export this page'}).getAttribute('href');
  await page.getByRole('textbox', {name: 'Exact SKU'}).fill('SKU-1000001');
  await page.getByRole('textbox', {name: 'Exact SKU'}).blur();
  await expect(page.getByText('Filters changed. Run the report to apply them.')).toBeVisible();
  expect(await page.getByRole('link', {name: 'Export this page'}).getAttribute('href')).toBe(previousExport);
  await page.getByRole('button', {name: 'Run report', exact: true}).click();
  await expect(page.getByText('3 positions on this page')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Next', exact: true})).toBeDisabled();
});

test('failed movement requests preserve the last complete report and its export', async ({page}) => {
  await page.goto('/?scenario=movement-error');
  await page.getByRole('button', {name: 'Run report', exact: true}).click();
  await expect(page.getByText('50 positions on this page')).toBeVisible();
  const previousExport = await page.getByRole('link', {name: 'Export this page'}).getAttribute('href');
  await page.getByRole('combobox', {name: 'Inventory location', exact: true}).selectOption('2');
  await page.getByRole('button', {name: 'Run report', exact: true}).click();
  await expect(page.getByText(/Synthetic movement access failure/)).toBeVisible();
  await expect(page.getByText(/The previous completed page is still shown/)).toBeVisible();
  expect(await page.getByRole('link', {name: 'Export this page'}).getAttribute('href')).toBe(previousExport);
});

test('cancelled reports do not overwrite a newer result', async ({page}) => {
  await page.goto('/?scenario=slow');
  await page.getByRole('button', {name: 'Run report', exact: true}).click();
  await page.getByRole('button', {name: 'Cancel', exact: true}).click();
  await page.getByRole('textbox', {name: 'Exact SKU'}).fill('SKU-1000001');
  await page.getByRole('textbox', {name: 'Exact SKU'}).blur();
  await page.getByRole('button', {name: 'Run report', exact: true}).click();
  await expect(page.getByText('3 positions on this page')).toBeVisible();
  await expect(page.getByText('50 positions on this page')).toHaveCount(0);
  await expect(page.getByRole('button', {name: 'Next', exact: true})).toBeDisabled();
});

test('an explicitly empty analytics result is not reported as a schema failure', async ({page}) => {
  await page.goto('/?scenario=empty-analytics');
  await page.getByRole('button', {name: 'Run report', exact: true}).click();
  await expect(page.getByText(/No inventory positions were returned by Analytics/)).toBeVisible();
  await expect(page.getByText('Report could not be completed', {exact: true})).toHaveCount(0);
  await expect(page.getByRole('link', {name: 'Export this page'})).toHaveCount(0);
});

test('a nonempty schema mismatch displays actionable metadata without values', async ({page}) => {
  await page.goto('/?scenario=unexpected-schema');
  await page.getByRole('button', {name: 'Run report', exact: true}).click();
  await expect(page.getByText(/required columns missing:/)).toBeVisible();
  await expect(page.getByText(/Returned columns: unexpected_metric/)).toBeVisible();
  await expect(page.getByRole('link', {name: 'Export this page'})).toHaveCount(0);
});

test('the actual rate-limit message is retried with a visible waiting state', async ({page}) => {
  await page.goto('/?scenario=rate-once');
  await page.getByRole('button', {name: 'Run report', exact: true}).click();
  await expect(page.getByText(/Shopify is rate limiting requests. Retrying in/)).toBeVisible();
  await expect(page.getByText('50 positions on this page')).toBeVisible();
  expect(await page.evaluate(() => window.reconciliationPreviewCalls.length)).toBe(3);
  await expect(page.getByText('Report could not be completed', {exact: true})).toHaveCount(0);
});

test('definitions disclose scope and the UI uses only Polaris tags', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Definitions and coverage'}).click();
  const modal = page.getByRole('dialog', {name: 'Definitions and coverage'});
  await expect(modal).toBeVisible();
  await expect(page.locator('#report-definitions').getByText(/cannot certify catalog items absent from both datasets/)).toBeVisible();
  const unexpected = await page.evaluate(() => [...document.querySelectorAll('body *')].map(e => e.tagName.toLowerCase()).filter(t => !t.startsWith('s-') && !['script', 'style', 'link'].includes(t)));
  expect(unexpected).toEqual([]);
});
