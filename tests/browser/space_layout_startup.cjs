/* Synthetic records and delayed assets model signed-in launches. Only visible
   geometry counts: cached rows, fresh records, and the Pool must fill the same
   panel. Record updates during an explicit range animation must not restart it. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
const day = '2026-11-18';
const rows = date => Array.from({ length: 24 }, (_, i) => ({
  id: date + ':' + i, day: date, title: 'Demo task ' + i, list_title: 'Daily',
  is_completed: i < 5, status: i < 5 ? 'completed' : 'needsAction',
}));

async function check(browser, engine, view, cached, collapsed = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  try {
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-11-18T20:00:00Z'));
    await context.addInitScript(({ view, day, cachedRows, collapsed }) => {
      if (location.pathname !== '/') return;
      localStorage.setItem('stellar:last-location', '/?view=' + view + '&day=' + day);
      localStorage.setItem('stellar:sidebar-collapsed', String(collapsed));
      if (cachedRows) localStorage.setItem('td:' + day, JSON.stringify(cachedRows));
      window.startupFrames = []; window.panelAnimations = 0;
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        if (this.matches('.dated-tasks')) window.panelAnimations++;
        return animate.apply(this, args);
      };
      const sample = () => {
        const host = document.querySelector('.wrap'), panel = host?.querySelector('.dated-tasks');
        if (panel && getComputedStyle(host).visibility === 'visible') {
          const rect = panel.getBoundingClientRect();
          window.startupFrames.push([rect.x, rect.y, rect.width, rect.height].map(Math.round));
        }
        if (!window.stopStartupFrames) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { view, day, cachedRows: cached ? rows(day) : null, collapsed });
    await context.route('**/app-assets/workspace.js?*', async route => {
      await new Promise(resolve => setTimeout(resolve, 250)); await route.fallback();
    });
    await context.route('**/pool?embedded=true', async route => {
      await new Promise(resolve => setTimeout(resolve, 450)); await route.fallback();
    });
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url()); let data = {};
      if (url.pathname.startsWith('/api/day/')) {
        await new Promise(resolve => setTimeout(resolve, 750)); data = rows(url.pathname.split('/').at(-1));
      } else if (url.pathname === '/api/range') {
        await new Promise(resolve => setTimeout(resolve, 750));
        const days = {};
        for (let date = new Date(url.searchParams.get('start') + 'T12:00:00Z'), end = new Date(url.searchParams.get('end') + 'T12:00:00Z'); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
          const key = date.toISOString().slice(0, 10); days[key] = rows(key);
        }
        data = { days, order: rows(day).map(row => row.title) };
      } else if (url.pathname === '/api/pool') {
        await new Promise(resolve => setTimeout(resolve, 650));
        data = { tasks: [{ id: 'star', title: 'Demo star', x: .8, y: .4 }], edges: [] };
      } else if (url.pathname === '/api/changes') data = { records: '1', definitions: '1', pool: '1' };
      await route.fulfill({ json: data });
    });
    await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
    await page.locator(view === 'day' ? '#tasks .task' : view === 'month' ? '.month .col' : '.range-table .range-task-name').first().waitFor();
    await page.frameLocator('#pool-frame').locator('#sky[data-loading=false]').waitFor();
    await page.waitForTimeout(450);
    const result = await page.evaluate(() => {
      window.stopStartupFrames = true;
      return { frames: startupFrames, animations: panelAnimations, range: document.body.dataset.range };
    });
    assert.equal(result.range, view);
    assert(result.frames.length > 10, 'Measure visible frames throughout delayed startup');
    assert.deepEqual([...new Set(result.frames.map(frame => JSON.stringify(frame)))], [JSON.stringify(result.frames[0])],
      `${engine}/${view}: the visible panel must keep its initial dimensions`);
    assert.equal(result.animations, 0, 'Loading records never animates panel width');
    if (view === 'day' && !cached) {
      await page.locator('[data-view=week]').click();
      await page.waitForFunction(() => window.panelAnimations === 1);
      await page.evaluate(() => {
        document.querySelector('#status').textContent = 'Refreshing records';
        document.querySelector('#tasks').append(document.createElement('div'));
      });
      await page.waitForTimeout(450);
      assert.equal(await page.evaluate(() => window.panelAnimations), 1, 'Record mutations leave the range animation running');
    }
    assert.deepEqual(errors, []);
    console.log(`${engine}: stable ${view} startup (${cached ? 'cached' : 'cold'}${collapsed ? ', collapsed sidebar' : ''}) passed`);
  } finally { await context.close(); }
}

(async () => {
  for (const engine of ['chromium', 'webkit']) {
    const browser = await ({ chromium, webkit })[engine].launch(engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
    try {
      for (const view of ['day', '3days', 'week', 'month', 'custom']) await check(browser, engine, view, false);
      await check(browser, engine, 'day', true, true);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
