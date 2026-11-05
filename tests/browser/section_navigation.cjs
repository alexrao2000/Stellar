/* Run against an isolated local Stellar fixture server. API requests use demo
   records only. Verify live section reuse, lazy loading, history, data changes,
   responsive layouts, and the absence of hidden-section polling in both engines. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
async function check(engine, mobile) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit }[engine]).launch(options);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      const interval = setInterval;
      window.setInterval = (fn, ms, ...args) => interval(fn, ms >= 15000 ? 400 : ms, ...args);
    });
    const records = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, day: '2026-11-04', title: i % 2 ? 'Read' : 'Run', list_title: 'Daily', is_completed: false, notes: '' }));
    let revision = 1;
    const calls = [], documents = [], errors = [];
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      calls.push({ path: url.pathname, url: url.href });
      let data = [];
      if (url.pathname === '/api/metrics') data = { revision: String(revision), modules: [{ id: 'overview', label: 'Overview', kind: 'overview' }, { id: 'weight', label: 'Weight', kind: 'weight' }, { id: 'wake', label: 'Wake', kind: 'wake' }] };
      else if (url.pathname === '/api/task_history' || url.pathname === '/api/consistency') data = records;
      else if (url.pathname === '/api/weights' || url.pathname === '/api/wake') data = [{ d: '2026-11-03', w: 150 }, { d: '2026-11-04', w: 151 }];
      else if (url.pathname.startsWith('/api/day/')) data = records.slice(0, 2);
      else if (url.pathname === '/api/pool') data = { tasks: [{ id: '1', title: 'Demo star', x: .4, y: .4, status: 'open' }], edges: [] };
      else if (url.pathname === '/api/range') data = { days: { '2026-11-04': records.slice(0, 2) }, today: '2026-11-04', floor: '2026-08-01' };
      await route.fulfill({ contentType: 'application/json', headers: { 'X-Day-Complete': '1' }, body: JSON.stringify(data) });
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.isNavigationRequest()) documents.push(request.url()); });
    const first = mobile ? '/?view=day&day=2026-11-04' : '/metrics?tab=weight';
    await page.goto(base + first);
    const rootIdentity = await page.evaluate(() => window.testIdentity = Math.random());
    const click = async label => {
      const toggle = page.getByRole('button', { name: 'Navigation menu', exact: true });
      if (mobile && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
      await page.getByRole('link', { name: label, exact: true }).click();
    };
    const frame = path => page.frames().find(frame => frame !== page.mainFrame() && new URL(frame.url()).pathname === path && frame.url().includes('tab_frame=true'));
    const readyFrame = async path => {
      await page.waitForFunction(path => Array.from(document.querySelectorAll('iframe.stellar-section')).some(f => { try { return new URL(f.contentWindow.location.href).pathname === path && f.contentDocument.readyState === 'complete'; } catch { return false; } }), path);
      return frame(path);
    };
    await page.waitForTimeout(900);
    assert(!documents.some(url => /\/(tasks|data)\?/.test(url)), 'Unvisited sections must not preload');
    await click('Activity');
    const activity = await readyFrame('/data');
    await activity.locator('#q').fill('Read');
    await activity.locator('#size').selectOption('20');
    await activity.evaluate(() => { window.testIdentity = 1234; scrollTo(0, 180); });
    const activityScroll = await activity.evaluate(() => scrollY);
    await click('Settings');
    const settings = await readyFrame('/tasks');
    await settings.locator('#new-title').fill('Keep my unfinished draft');
    await click('Activity');
    assert.equal(await activity.locator('#q').inputValue(), 'Read');
    assert.equal(await activity.evaluate(() => window.testIdentity), 1234);
    assert.equal(await activity.evaluate(() => scrollY), activityScroll, 'Scroll position survives switching');
    await click('Metrics');
    const metrics = mobile ? await readyFrame('/metrics') : page.mainFrame();
    await metrics.locator('#metric-panel[aria-busy=false]').waitFor();
    await metrics.getByRole('tab', { name: 'Weight', exact: true }).click();
    await metrics.locator('#metric-panel[aria-busy=false]').waitFor();
    const chart = await metrics.locator('#metric-frame').elementHandle();
    await page.waitForTimeout(900);
    const returns = [];
    for (let i = 0; i < 3; i++) {
      await click('Activity');
      const beforeDocs = documents.length, beforeWeights = calls.filter(c => c.path === '/api/weights').length;
      const start = Date.now();
      await click('Metrics');
      await metrics.locator('#metric-panel[aria-busy=false]').waitFor();
      returns.push(Date.now() - start);
      assert.equal(documents.length, beforeDocs, 'A warm return must not reload documents');
      assert.equal(calls.filter(c => c.path === '/api/weights').length, beforeWeights, 'A warm return must reuse chart data');
      if (mobile) {
        await page.waitForTimeout(50);
        assert.equal(await metrics.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mobile-nav-height')), await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mobile-nav-height')), 'Cached mobile pages track the closed menu height');
      }
      assert(await chart.evaluate(node => node === document.getElementById('metric-frame')), 'Chart identity survives switching');
    }
    if (mobile) await page.screenshot({ path: `/private/tmp/stellar-metrics-warm-${engine}.png` });
    await click('Settings');
    assert.equal(await settings.locator('#new-title').inputValue(), 'Keep my unfinished draft');
    await page.goBack();
    await page.waitForURL('**/metrics?tab=weight');
    await page.goForward();
    await page.waitForURL('**/tasks');
    assert.equal(await settings.locator('#new-title').inputValue(), 'Keep my unfinished draft');
    const beforeHidden = calls.filter(c => c.path === '/api/metrics').length;
    await page.waitForTimeout(1000);
    assert.equal(calls.filter(c => c.path === '/api/metrics').length, beforeHidden, 'Hidden Metrics must stop polling');
    revision++;
    await settings.evaluate(() => window.stellarRecordsChanged());
    await page.waitForTimeout(120);
    assert.equal(calls.filter(c => c.path === '/api/metrics').length, beforeHidden, 'Hidden Metrics defers invalidation');
    const beforeRefresh = calls.filter(c => c.path === '/api/weights').length;
    await click('Metrics');
    await page.waitForFunction(() => !document.querySelector('iframe.stellar-section:not([hidden])') || document.querySelector('iframe.stellar-section:not([hidden])').contentWindow.stellarPageActive());
    await page.waitForTimeout(500);
    assert(calls.filter(c => c.path === '/api/weights').length > beforeRefresh, 'Changed records refresh cached charts on return');
    await click('Space');
    const space = mobile ? page.mainFrame() : await readyFrame('/');
    await space.getByRole('button', { name: 'Week', exact: true }).click();
    await page.waitForURL(/view=week/);
    await click('Activity');
    await page.goBack();
    await page.waitForURL(/view=week/);
    assert.equal(await space.locator('body').getAttribute('data-range'), 'week');
    await page.goBack();
    await page.waitForURL(url => !url.searchParams.has('view') || url.searchParams.get('view') === 'day');
    assert.equal(await space.locator('body').getAttribute('data-range'), 'day');
    if (!mobile) {
      await page.getByRole('button', { name: 'Collapse sidebar' }).click();
      await page.waitForTimeout(450);
      assert(await space.locator('html').evaluate(node => node.classList.contains('sidebar-collapsed')));
    }
    assert.equal(await page.evaluate(() => window.testIdentity), rootIdentity);
    for (const f of page.frames().filter(f => !f.isDetached())) if (await f.evaluate(() => window.stellarPageActive?.() === true)) assert.equal(await f.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No horizontal clipping');
    assert.deepEqual(errors, []);
    console.log(`${engine} ${mobile ? 'mobile' : 'desktop'}: warm returns ${returns.join(', ')} ms; retained state, history, deferred refresh, and hidden polling passed`);
    await page.screenshot({ path: `/private/tmp/stellar-navigation-${engine}-${mobile ? 'mobile' : 'desktop'}.png` });
    await context.route('**/login?**', route => route.fulfill({ contentType: 'text/html', body: '<title>Sign in</title>Sign in' }));
    await context.route('**/api/expired', route => route.fulfill({ status: 401, body: '{}' }));
    await space.evaluate(() => fetch('/api/expired').catch(() => {}));
    await page.waitForURL('**/login?next=**');
    assert.equal(await page.locator('iframe.stellar-section').count(), 0, 'Expiry clears private section documents');
  } finally { await browser.close(); }
}
(async () => { for (const engine of ['chromium', 'webkit']) for (const mobile of [false, true]) await check(engine, mobile); })().catch(error => { console.error(error); process.exit(1); });
