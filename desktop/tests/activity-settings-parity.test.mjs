import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { launchFixture } from './support.mjs';
import { healthGroup, tokens, duration, percent, attentionItems, rollingSearch } from '../src/lib/activity-presenter.ts';
import { configurationChanges } from '../src/lib/settings-presenter.ts';

test('activity/settings presentation keeps measured zero separate from missing observations', () => {
  assert.equal(duration(0), '0 ms'); assert.equal(duration(null), 'Not recorded');
  assert.equal(percent(0), '0%'); assert.equal(percent(null), 'Not measured');
  assert.equal(tokens({ calls: 2, usageCalls: 0, totalTokens: 0 }), 'Not reported');
  assert.equal(tokens({ calls: 0, usageCalls: 0, totalTokens: 0 }), '0');
  const checks = [{ name: 'connections-and-harnesses', status: 'unknown', message: 'No model configured' }];
  assert.equal(healthGroup(checks[0], checks), 'off');
  assert.equal(healthGroup({ name: 'cli-version', status: 'unknown', message: 'Not probed' }, checks), 'unchecked');
  assert.deepEqual(configurationChanges([{ key: 'search.defaultExcludeTypes', label: 'Hide', kind: 'list' }, { key: 'defaultWriteTarget', label: 'Target' }], { 'search.defaultExcludeTypes': '', defaultWriteTarget: 'personal' }, { 'search.defaultExcludeTypes': 'memory, script', defaultWriteTarget: '' }), { set: { 'search.defaultExcludeTypes': '["memory","script"]' }, unset: ['defaultWriteTarget'] });
});

test('attention ranks real faults before review work and never treats unknown runs as failures', () => {
  const data = { health: { status:'warn', hardChecks:[{name:'disk',status:'fail',message:'Full'}], advisories:[{name:'index',status:'warn',message:'Stale'}] }, improveRuns:[{ok:null},{ok:false}] };
  const pulse = { tiles:{ runs:{failedTasks:[]} }, attention:{ pending:{count:3},misses:{queries:1},harm:{reverted:0},setup:null } };
  const items = attentionItems(data,pulse);
  assert.deepEqual(items.map(item=>item.tone), ['fail','fail','warn','work','work']);
  assert.match(items[1].text,/1 failed improve runs/);
  assert.equal(items[3].href,'#/proposals');
  assert.equal(attentionItems({health:null,improveRuns:[{ok:null}]},null).length,0);
});

test('rolling retrieval does not turn missing daily observations into measured zero', () => {
  const today = new Date().toISOString().slice(0,10);
  const sparse = {daily:[{date:today,searches:10,zeroResults:0,medianMs:1}],weekly:[],centre:null};
  assert.equal(rollingSearch(sparse,[],7).rates.at(-1),null);
  const complete = {...sparse,daily:Array.from({length:7},(_,i)=>({date:new Date(Date.now()-(6-i)*86400000).toISOString().slice(0,10),searches:1,zeroResults:0,medianMs:1}))};
  assert.equal(rollingSearch(complete,[],7).rates.at(-1),100);
});

test('Activity and Settings restore populated upstream capabilities through existing APIs', { timeout: 240000 }, async t => {
  const server = await launchFixture({ metrics: true, proposals: true }); t.after(() => server.stop());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const failures = []; page.on('pageerror', error => failures.push(error.message));
  const screenshots = process.env.AKM_DESKTOP_SCREENSHOTS || path.join(server.root, 'activity-settings-screenshots');
  await mkdir(screenshots, { recursive: true });
  const shot = async name => { await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(screenshots, name), fullPage: true }); };
  const navigate = hash => page.evaluate(hash => { location.hash = hash; }, hash);
  const tableView = title => page.getByRole('group', { name: `${title} view`, exact: true }).getByRole('button', { name: 'Table', exact: true });
  await page.goto(server.url);

  await t.test('Health prioritizes actionable records without pretending refresh is a probe', async () => {
    const probes = [];
    const observe = request => { if (new URL(request.url()).pathname === '/api/health') probes.push(request.url()); };
    page.on('request', observe);
    await navigate('#/overview');
    await expect(page.getByRole('heading', { name: 'Needs attention', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Health', exact: true })).toBeVisible();
    await expect(page.getByText(/Individual check timestamps are not reported/)).toBeVisible();
    await expect(page.locator('#activity-operations')).toHaveCount(0);
    assert.deepEqual(probes, [], 'Opening Health does not request explicit endpoint probes');
    page.off('request', observe);
    await shot('activity-health-light.png');
  });

  await t.test('overview renders real ECharts, retrieval control bands, latency and exact model dimensions', async () => {
    const measured = (await server.call('/api/overview')).body.data;
    const retrieval = (await server.call('/api/retrieval')).body.data;
    assert.ok(measured.metrics.usage.totals.searches > 0, 'Representative fixture must include search summary rows');
    assert.ok(retrieval.weekly.length > 3 && retrieval.daily.some(row => row.medianMs !== null), 'Representative fixture must include measured retrieval and latency');
    await navigate('#/overview?view=retrieval');
    await expect(page.getByRole('heading', { name: 'Is search finding what you need?', exact: true })).toBeVisible();
    await expect(page.locator('#activity-retrieval-rate svg')).toHaveCount(1);
    await expect(page.locator('#activity-latency svg')).toHaveCount(1);
    await tableView('Is search finding what you need?').click();
    await expect(page.getByRole('table', { name: 'Weekly retrieval and control bands' })).toContainText('Usual range');
    await tableView('Model calls').click();
    const processTable = page.getByRole('table', { name: 'By process', exact: true });
    await expect(processTable).toContainText('reflect');
    await expect(processTable).toContainText('triage.judgment');
    await expect(processTable.getByRole('row').filter({ hasText: 'triage.judgment' })).toContainText('Not reported');
    await expect(page.getByRole('table', { name: 'By execution target', exact: true })).toContainText('synthetic');
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/overview' && new URL(request.url()).searchParams.get('metricsSince') === '90d');
    await page.getByRole('combobox', { name: 'Trend window', exact: true }).selectOption('90d'); await requested;
    await expect(page).toHaveURL(/window=90d/);
    await expect(page.locator('#activity-operations svg')).toHaveCount(1);
    await shot('activity-overview-light.png');
  });

  await t.test('task and improve-run drill-down show actual failure and process records', async () => {
    await navigate('#/overview?view=runs');
    await page.getByRole('button', { name: 'synthetic-failure', exact: true }).click();
    const task = page.getByRole('region', { name: 'Task run details', exact: true });
    await expect(task).toContainText('failed');
    await task.getByText('timeout', { exact: true }).click();
    await expect(task).toContainText('Synthetic timeout');
    await expect(page.getByRole('table', { name: 'Improve run records', exact: true })).toBeVisible();
    const runLink = page.getByRole('button', { name: 'Inspect run synthetic-improve-1', exact: true }).last();
    await runLink.click();
    const run = page.getByRole('region', { name: 'Improve run details', exact: true });
    await expect(run.getByRole('table', { name: 'Run calls by process' })).toContainText('reflect');
    await run.getByText('Triage result', { exact: true }).click(); await expect(run).toContainText('"failed": 1');
    await shot('activity-task-and-run.png');
    await run.getByRole('button', { name: 'Back to run records', exact: true }).click();
    await expect(runLink).toBeFocused();
  });

  await t.test('impact preserves decider splits, cost coverage, uncollapsed harm and proposal drill context', async () => {
    const impact = (await server.call('/api/improve/impact')).body.data;
    assert.ok(impact.outcomes.length && impact.summary.checked > 0, 'Fixture must have actual decided proposals, not only an empty impact chart');
    assert.ok(impact.library.filter(row => row.entries !== null).length >= 2, 'Fixture must have multiple index snapshots');
    await navigate('#/improve');
    await expect(page.locator('#impact-weekly-outcomes svg')).toHaveCount(1);
    await expect(page.locator('#impact-outcomes svg')).toHaveCount(1);
    await expect(page.locator('#impact-library-size svg')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: /Harm log/ })).toBeVisible();
    await expect(page.locator('#harm')).toContainText('Reverted');
    await tableView('Who decided what').click();
    const table = page.getByRole('table', { name: 'Decision outcomes by process and week' });
    await expect(table).toContainText('Accepted by the judge'); await expect(table).toContainText('Accepted, decider not recorded');
    const drill = table.getByRole('button', { name: /Accepted by you:/ }).first(); await drill.click();
    const decisionDetails = page.getByRole('region', { name: 'Decision proposal details' });
    await expect(decisionDetails).toContainText('personal//');
    const proposalLink = decisionDetails.getByRole('link').filter({ hasText: /^personal\/\// }).first();
    const scopedHref = await proposalLink.getAttribute('href');
    assert.match(scopedHref, /status=recent/);
    assert.match(scopedHref, /source=/);
    assert.match(scopedHref, /class=you/);
    assert.match(scopedHref, /returnTo=/);
    await proposalLink.click();
    await page.getByRole('link', { name: 'Back to improve impact', exact: true }).click();
    await expect(decisionDetails).toContainText('personal//');
    await tableView('What does improve cost?').click();
    await expect(page.getByRole('table', { name: 'Calls and reported tokens by week' })).toContainText('triage.judgment');
    const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/api/improve/impact' && new URL(request.url()).searchParams.get('since') === '365d');
    await page.getByRole('combobox', { name: 'Impact window' }).selectOption('365d'); await requested;
    await expect(page).toHaveURL(/since=365d/);
    await expect(page.locator('.impact-summary')).toContainText('Last year:');
    await expect(page.locator('#impact-cost svg')).toHaveCount(1);
    await shot('activity-impact-light.png');
    await page.getByRole('combobox', { name: 'Appearance' }).selectOption('dark');
    await shot('activity-impact-dark.png');
    await page.getByRole('combobox', { name: 'Appearance' }).selectOption('light');
  });

  await t.test('bundle metadata, inferred component controls, folder choice and browse-to-library stay usable', async () => {
    await navigate('#/bundles');
    const shared = page.getByRole('article', { name: 'Bundle shared', exact: true });
    await expect(shared).toContainText('Indexed assets');
    await shared.getByRole('link', { name: 'Manage shared', exact: true }).click();
    await expect(page).toHaveURL(/#\/bundles\?manage=shared$/);
    const management = page.getByRole('article', { name: 'Manage bundle shared', exact: true });
    await expect(management.getByRole('group', { name: 'Component access' })).toBeVisible();
    await expect(management.locator('details')).toHaveCount(0);
    const returned = (await server.call('/api/bundles')).body.data.bundles.find(bundle => bundle.name === 'shared');
    for (const component of returned.components) {
      const checkbox = management.getByRole('switch', { name: new RegExp(`^${component.name} writable`) });
      if (!component.configured) await expect(checkbox).toBeDisabled();
    }
    const writable = management.getByRole('switch', { name: 'Bundle writable default', exact: true });
    const before = await writable.isChecked(); await writable.setChecked(!before);
    await page.getByRole('link', { name: 'Back to bundles', exact: true }).click();
    await expect(shared).toBeVisible();
    await page.goBack();
    await expect(writable).toBeChecked({ checked: !before });
    await management.getByRole('button', { name: 'Unregister shared…', exact: true }).click();
    await expect(management.getByRole('button', { name: 'Confirm removal', exact: true })).toBeDisabled();
    await management.getByRole('checkbox', { name: 'Remove shared registration', exact: true }).check();
    await expect(management.getByRole('button', { name: 'Confirm removal', exact: true })).toBeEnabled();
    await management.getByRole('button', { name: 'Keep bundle', exact: true }).click();
    assert.ok((await server.call('/api/bundles')).body.data.bundles.some(bundle => bundle.name === 'shared'), 'Cancelling unregister must retain the registered bundle');
    await shot('settings-manage-light.png');
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/bundles/settings' && response.request().method() === 'POST');
    await management.getByRole('button', { name: 'Save shared settings', exact: true }).click(); assert.equal((await saved).status(), 200);
    await expect.poll(async () => (await server.call('/api/bundles')).body.data.bundles.find(bundle => bundle.name === 'shared').writable).toBe(!before);
    // Restore its writable policy before the later default-write-target check.
    await writable.setChecked(before);
    const restored = page.waitForResponse(r => r.url().endsWith('/api/bundles/settings') && r.request().method() === 'POST');
    await management.getByRole('button', { name: 'Save shared settings', exact: true }).click();
    assert.equal((await restored).status(), 200);
    await management.getByRole('link', { name: 'Browse shared assets', exact: true }).click();
    await expect(page).toHaveURL(/#\/search\?bundle=shared/);
    await navigate('#/bundles');
    await mkdir(path.join(server.root, 'home/picker-example'), { recursive: true });
    await page.getByRole('button', { name: 'Browse folders…', exact: true }).click();
    const picker = page.getByRole('dialog'); await picker.getByRole('button', { name: /picker-example/ }).click();
    await picker.getByRole('button', { name: 'Use this folder', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Source', exact: true })).toHaveValue(path.join(server.root, 'home/picker-example'));
    await shot('settings-bundles-light.png');
  });

  await t.test('grouped validated config saves react to edits, preserve failed drafts and show provenance', async () => {
    await navigate('#/config');
    await page.getByRole('link', { name: 'Command output', exact: true }).click();
    const format = page.getByRole('combobox', { name: 'Format', exact: true, includeHidden: true });
    await format.selectOption('yaml');
    await page.getByRole('link', { name: 'Library defaults', exact: false }).click();
    await page.getByRole('combobox', { name: 'Default write target', exact: true }).selectOption('shared');
    const save = page.getByRole('button', { name: 'Save library defaults', exact: true });
    await expect(save).toBeEnabled();
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/config/set' && response.request().method() === 'POST');
    await save.click(); assert.equal((await response).status(), 200);
    await expect.poll(async () => (await server.call('/api/config')).body.data.config.defaultWriteTarget).toBe('shared');
    await expect(format).toHaveValue('yaml');
    await expect(page.getByRole('button', { name: 'Save command output', exact: true, includeHidden: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Refresh settings', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh settings', exact: true })).toBeEnabled();
    await expect(page.getByRole('combobox', { name: 'Default write target', exact: true })).toHaveValue('shared');
    await expect(format).toHaveValue('yaml');
    await expect(page.getByRole('button', { name: 'Save command output', exact: true, includeHidden: true })).toBeEnabled();
    await shot('settings-config-clean-light.png');
    await page.getByRole('link', { name: /^Command output/ }).click();
    await format.selectOption('yaml');
    await page.route('**/api/config/set', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, code: 'FIXTURE_CONFLICT', error: 'Synthetic safe retry case' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Save command output', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Synthetic safe retry case'); await expect(format).toHaveValue('yaml');
    await page.getByRole('link', { name: 'Advanced', exact: true }).click();
    await page.locator('.effective-config summary').filter({ hasText: /^defaultWriteTarget$/ }).click();
    await expect(page.getByRole('table', { name: 'defaultWriteTarget effective values' })).toContainText('Set in config.json');
    await shot('settings-config-light.png');
    await page.getByRole('combobox', { name: 'Appearance' }).selectOption('dark'); await shot('settings-config-dark.png');
    await page.setViewportSize({ width: 390, height: 844 }); await shot('settings-config-narrow.png');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Settings must not overflow the document on narrow screens');
    await page.setViewportSize({ width: 1440, height: 1000 });
  });

  // Actual upstream screenshots use precisely the same generated stores, never a live bundle.
  const referenceServer = fork(fileURLToPath(new URL('./review-upstream-server.mjs', import.meta.url)), [], { env: { ...server.env, AKM_DESKTOP_TEST_ROOT: server.root }, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (referenceServer.connected) referenceServer.send('shutdown'); });
  const reference = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Upstream synthetic reference server timed out')), 15000); referenceServer.once('message', value => { clearTimeout(timer); resolve(value); }); referenceServer.once('error', reject); });
  const baseline = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  for (const route of ['overview', 'improve', 'bundles', 'config']) { await baseline.goto(`${reference.url}#/${route}`); await baseline.waitForLoadState('networkidle'); await baseline.screenshot({ path: path.join(screenshots, `upstream-${route}-reference.png`), fullPage: true }); }
  await baseline.close();
  assert.deepEqual(failures, [], 'No page errors should be hidden by chart fallbacks');
  console.log(`Activity/settings visual evidence: ${screenshots}`);
});
