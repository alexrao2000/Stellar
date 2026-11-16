/* Hold the network open so a fast cache paint cannot accidentally pass by
   waiting for the mocked server. All dates and task records are synthetic. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
const day = '2026-11-04';
const rows = (day, done) => [{
  id: day, day, title: 'Run', list_title: 'Daily',
  status: done ? 'completed' : 'needsAction', is_completed: done,
}];

async function check(engine) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit })[engine].launch(options);
  try {
    for (const cold of [true, false]) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
      });
      const page = await context.newPage();
      let releaseRange, releaseRefresh;
      const range = new Promise(resolve => { releaseRange = resolve; });
      const refresh = new Promise(resolve => { releaseRefresh = resolve; });
      await page.clock.setFixedTime(new Date('2026-11-04T17:00:00Z'));
      const reads = [];
      let done = false;
      await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        const doneAtStart = done;
        if (url.pathname === '/api/range') {
          reads.push(url);
          if (!doneAtStart) await (reads.length === 1 ? range : refresh);
          const days = {};
          const end = new Date(url.searchParams.get('end') + 'T12:00:00Z');
          for (let date = new Date(url.searchParams.get('start') + 'T12:00:00Z'); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
            const key = date.toISOString().slice(0, 10);
            days[key] = rows(key, doneAtStart);
          }
          await route.fulfill({ json: { days, order: ['Run'] } });
        } else if (url.pathname.startsWith('/api/day/')) {
          if (cold) await refresh;
          await route.fulfill({ json: rows(url.pathname.split('/')[3], doneAtStart) });
        } else if (url.pathname === '/api/changes' && done) {
          await route.fulfill({ json: { records: 1, definitions: 0, pool: 0 } });
        } else {
          await route.fulfill({ json: {} });
        }
      });
      const firstRange = page.waitForRequest(request => new URL(request.url()).pathname === '/api/range');
      await page.goto(base + '/?day=' + day, { waitUntil: 'domcontentloaded' });
      if (!cold) {
        await page.locator('#tasks .task').first().waitFor();
        await firstRange;
      }
      await page.locator('[data-view="3days"]').tap();
      await firstRange;
      await page.waitForFunction(() => typeof window.stellarRenderRange === 'function', undefined, { timeout: 2000 });
      assert.equal(reads.length, 1, '3 Days shares the covering read already in flight');
      assert.equal(await page.locator('.range-table-compact').count(), 0, 'The renderer arrived while the records were held');
      releaseRange();
      await page.locator('.range-table-compact .range-check').first().waitFor();
      if (!cold) {
        for (const [view, content] of [
          ['week', '.range-focus .mini'], ['month', '.month .col-head .cnt'],
          ['custom', '.range-focus .mini'], ['3days', '.range-table-compact .range-check'], ['day', '#tasks .task'],
        ]) {
          await page.locator(`[data-view="${view}"]`).tap();
          await page.locator(content).first().waitFor({ timeout: 1000 });
          if (view === 'month') assert.equal(await page.locator('.month .col-body').count(), 0);
        }
        const oldRead = page.waitForRequest(request => request.url().includes('/api/range?start=2026-11-01&end=2026-11-30'));
        await page.goto(base + '/?view=month&day=' + day, { waitUntil: 'domcontentloaded' });
        const oldRequest = await oldRead;
        await page.locator('.month .col-head .cnt').first().waitFor({ timeout: 1000 });
        await page.locator('[data-view="3days"]').tap();
        const completed = page.getByRole('button', { name: 'Run, Nov 4, Done', exact: true });
        assert.equal(await completed.count(), 0);
        done = true;
        await page.evaluate(() => window.StellarSync.check());
        await completed.waitFor({ timeout: 3000 });
        releaseRefresh();
        const oldResponse = await oldRequest.response();
        await oldResponse.finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert(await completed.isVisible(), 'An older range response cannot undo the synced status');
      }
      releaseRefresh();
      await context.close();
    }
    console.log(engine + ': parallel cold load, shared warmup, cached range switching and live sync passed');
  } finally {
    await browser.close();
  }
}

(async () => { for (const engine of ['chromium', 'webkit']) await check(engine); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
