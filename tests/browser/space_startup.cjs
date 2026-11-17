/* Use fake records and hold the live read to check that app startup paints
   from device storage. Test the real worker with Chromium offline and with
   API requests blocked in WebKit, whose offline mode rejects cached navigations. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
const day = '2026-11-16', days = ['2026-11-15', day, '2026-11-17'];
const url = '/?view=3days&day=' + day;
const version = records => ({ records: String(records), definitions: '1', pool: '1' });
const payload = done => ({
  days: Object.fromEntries(days.map(day => [day, [{
    day, id: day, title: 'Morning run', list_title: 'Daily', is_completed: done,
    status: done ? 'completed' : 'needsAction',
  }]])), order: ['Morning run'],
});
const row = '.range-table-compact .range-task-name';

async function verifyRestore(browser, engine) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-11-16T16:00:00Z'));
    await page.addInitScript(({ url, rows }) => {
      if (location.pathname !== '/' || location.search) return;
      localStorage.setItem('stellar:last-location', url);
      for (const [date, tasks] of Object.entries(rows)) localStorage.setItem('td:' + date, JSON.stringify(tasks));
    }, { url, rows: payload(false).days });
    let release, revision = 1, reads = 0, checks = 0, unauthorized = false;
    const liveRead = new Promise(resolve => { release = resolve; });
    const navigations = [];
    page.on('request', request => { if (request.resourceType() === 'document') navigations.push(request.url()); });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url());
      if (path.pathname === '/api/range') {
        reads++;
        if (unauthorized) return route.fulfill({ status: 401, json: { detail: 'Sign in required' } });
        if (reads === 1) {
          assert.equal(path.searchParams.get('with_revisions'), 'true');
          await liveRead;
        }
        return route.fulfill({ json: payload(revision > 1), headers: { 'X-Stellar-Revisions': JSON.stringify(version(revision)) } });
      }
      if (path.pathname === '/api/changes') {
        checks++;
        return route.fulfill({ json: version(revision) });
      }
      await route.fulfill({ json: {} });
    });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.locator(row).first().waitFor();
    assert.equal(new URL(page.url()).search, new URL(url, base).search);
    assert.deepEqual(navigations, [base + '/']);
    assert.equal(reads, 1);
    assert.equal(checks, 0);
    release();
    await page.waitForFunction(() => window.StellarSync.managed);
    await page.evaluate(() => window.StellarSync.check());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(reads, 1, 'A matching revision leaves the opening read in place');
    revision = 2;
    await page.evaluate(() => window.StellarSync.check());
    await page.getByRole('button', { name: 'Morning run, Nov 16, Done', exact: true }).waitFor();
    assert.equal(reads, 2, 'A newer revision still refreshes records');

    unauthorized = true;
    await page.route('**/login?next=*', route => route.fulfill({ body: '<form id="signin">Sign in</form>', contentType: 'text/html' }));
    await page.goto(base + '/space-shell' + new URL(url, base).search, { waitUntil: 'commit' });
    await page.locator('#signin').waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('stellar:space-cache-ready')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('td:2026-11-16')), null);
    console.log(engine + ': one-document restore, immediate cached tasks, revision deduplication and signed-out cache clearing passed');
  } finally { await context.close(); }
}

async function verifyOfflineShell(browser, engine) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.clock.setFixedTime(new Date('2026-11-16T16:00:00Z'));
    await context.route('**/api/**', route => route.fulfill({
      json: payload(false), headers: { 'X-Stellar-Revisions': JSON.stringify(version(1)) },
    }));
    await page.goto(base + url);
    await page.locator(row).first().waitFor();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    assert(await page.evaluate(async () => (await caches.match('/space-shell')).ok));
    await context.unrouteAll();
    if (engine === 'chromium') await context.setOffline(true);
    else await context.route('**/api/**', route => route.abort());
    const response = await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    assert(response.fromServiceWorker());
    await page.locator(row).first().waitFor();
    assert.equal(await page.locator(row).first().textContent(), 'Morning run');
    await page.evaluate(() => window.stellarClearTaskCache());
    await page.goto(base + url, { waitUntil: 'domcontentloaded' });
    await page.getByText(/Could not load/).waitFor();
    assert.equal(await page.locator(row).count(), 0);
    console.log(engine + ': installed shell and cached range opened without the records API');
  } finally { await context.close(); }
}

(async () => {
  for (const engine of ['chromium', 'webkit']) {
    const browser = await ({ chromium, webkit })[engine].launch(engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
    try {
      await verifyRestore(browser, engine);
      await verifyOfflineShell(browser, engine);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
