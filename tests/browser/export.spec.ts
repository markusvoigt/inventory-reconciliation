import {test, expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const savedKey = 'inventory-reconciliation:preview:csv:gid://shopify/Shop/1';

test('complete filtered CSV is actually downloadable and includes all locations', async ({page}) => {
  await page.goto('/?scenario=export-parts');
  await page.getByRole('textbox', {name: 'Exact SKU'}).fill('SKU-1000001');
  await page.getByRole('textbox', {name: 'Exact SKU'}).blur();
  await page.getByRole('button', {name: 'Export CSV', exact: true}).click();
  const modal = page.locator('#csv-export');
  await modal.getByRole('button', {name: 'Prepare CSV', exact: true}).click();
  await expect(modal.getByText('Selection complete', {exact: true})).toBeVisible();
  await expect(modal.getByText('3 rows across 1 file(s) for this selection.')).toBeVisible();
  const pending = page.waitForEvent('download');
  await modal.getByRole('link', {name: 'Download CSV', exact: true}).click();
  const download = await pending;
  const csv = await readFile((await download.path())!, 'utf8');
  expect(download.suggestedFilename()).toMatch(/part-0001-final.csv$/);
  expect(csv.charCodeAt(0)).toBe(0xFEFF);
  expect(csv).toContain('Filtered report export');
  expect(csv).toContain('Central warehouse'); expect(csv).toContain('City store'); expect(csv).toContain('Returns hub');
  expect(csv.split('\r\n')).toHaveLength(4);
  expect(await page.evaluate(() => window.reconciliationPreviewCalls.length)).toBe(2);
  await modal.getByRole('button', {name: 'Done', exact: true}).click();
  await expect(page.getByRole('dialog', {name: 'Export inventory CSV'})).not.toBeVisible();
  expect(await page.evaluate(k => localStorage.getItem(k), savedKey)).toBeNull();
});

test('large export pauses for download confirmation and resumes after reload without losing the boundary', async ({page}) => {
  test.setTimeout(60_000);
  await page.goto('/?scenario=export-parts');
  await page.getByRole('button', {name: 'Export CSV', exact: true}).click();
  const modal = page.locator('#csv-export');
  await modal.getByRole('button', {name: 'Prepare CSV', exact: true}).click();
  await expect(modal.getByText('Part 1 ready', {exact: true})).toBeVisible({timeout: 20_000});
  const link = modal.getByRole('link', {name: 'Download CSV part 1', exact: true});
  const uri = (await link.getAttribute('href'))!;
  expect(uri.length).toBeLessThanOrEqual(2 * 1024 * 1024);
  await expect(modal.getByRole('button', {name: 'Prepare next part', exact: true})).toBeDisabled();
  const downloadPromise = page.waitForEvent('download');
  await link.click();
  const download = await downloadPromise;
  const csv = await readFile((await download.path())!, 'utf8');
  const rows = csv.split('\r\n').slice(1);
  expect(rows.length).toBeGreaterThan(500); expect(rows.length).toBeLessThanOrEqual(5000);
  const lastId = rows[rows.length - 1].split(',')[4].replaceAll('"', '');
  // Merely preparing or requesting a download does not advance the checkpoint.
  const before = JSON.parse((await page.evaluate(k => localStorage.getItem(k), savedKey))!);
  expect(before.completedRows).toBe(0); expect(before.after).toBeNull();
  await modal.getByRole('checkbox', {name: 'I saved this CSV part'}).check();
  await modal.getByRole('button', {name: 'Prepare next part', exact: true}).click();
  await expect(modal.getByText('Part 2 ready', {exact: true})).toBeVisible({timeout: 20_000});
  const nextUri = (await modal.getByRole('link', {name: 'Download CSV part 2', exact: true}).getAttribute('href'))!;
  const nextFirstId = decodeURIComponent(nextUri.slice(nextUri.indexOf(',') + 1)).split('\r\n')[1].split(',')[4].replaceAll('"', '');
  expect(BigInt(nextFirstId)).toBeGreaterThan(BigInt(lastId));
  const checkpoint = JSON.parse((await page.evaluate(k => localStorage.getItem(k), savedKey))!);
  expect(checkpoint.completedRows).toBe(rows.length); expect(checkpoint.nextPart).toBe(2); expect(checkpoint.after.itemId).toBe(lastId);
  await page.reload();
  await page.getByRole('button', {name: 'Export CSV', exact: true}).click();
  await modal.getByRole('button', {name: 'Resume export', exact: true}).click();
  await expect(modal.getByText('Part 2 ready', {exact: true})).toBeVisible({timeout: 20_000});
  const resumedUri = (await modal.getByRole('link', {name: 'Download CSV part 2', exact: true}).getAttribute('href'))!;
  const resumedFirstId = decodeURIComponent(resumedUri.slice(resumedUri.indexOf(',') + 1)).split('\r\n')[1].split(',')[4].replaceAll('"', '');
  expect(resumedFirstId).toBe(nextFirstId);
});

test('a failed later page offers no partial file and preserves the part-start checkpoint', async ({page}) => {
  await page.goto('/?scenario=export-error');
  await page.getByRole('button', {name: 'Export CSV', exact: true}).click();
  const modal = page.locator('#csv-export');
  await modal.getByRole('button', {name: 'Prepare CSV', exact: true}).click();
  await expect(modal.getByText(/Synthetic export failure after first page/)).toBeVisible();
  await expect(modal.getByRole('link', {name: /Download CSV/})).toHaveCount(0);
  const checkpoint = JSON.parse((await page.evaluate(k => localStorage.getItem(k), savedKey))!);
  expect(checkpoint.completedRows).toBe(0); expect(checkpoint.after).toBeNull();
  await expect(modal.getByRole('button', {name: 'Resume export', exact: true})).toBeVisible();
});

test('cancel export aborts retrieval and unlocks browsing without exposing a partial file', async ({page}) => {
  await page.goto('/?scenario=slow');
  await page.getByRole('button', {name: 'Export CSV', exact: true}).click();
  const modal = page.locator('#csv-export');
  await modal.getByRole('button', {name: 'Prepare CSV', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Run report', exact: true})).toBeDisabled();
  await modal.getByRole('button', {name: 'Cancel export', exact: true}).click();
  await expect(page.getByRole('dialog', {name: 'Export inventory CSV'})).not.toBeVisible();
  await expect(page.getByRole('button', {name: 'Run report', exact: true})).toBeEnabled();
  expect(await modal.getByRole('link', {name: /Download CSV/}).count()).toBe(0);
});
