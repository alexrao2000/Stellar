/* Demo-only period navigation verifies exact rolling boundaries, leap years,
   cached task frames, comparison locking, reopening, and mobile layout. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
async function check(engine, mobile) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit }[engine]).launch(options);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'America/Los_Angeles', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile });
    await context.addInitScript(() => {
      const D = Date, offset = D.parse('2026-11-05T20:00:00Z') - D.now();
      window.Date = class extends D { constructor(...args) { super(...(args.length ? args : [D.now() + offset + (window.periodTestShift || 0)])); } static now() { return D.now() + offset + (window.periodTestShift || 0); } };
      if (!localStorage.getItem('period-test-started')) { localStorage.setItem('stellar:heat-year', '2025'); localStorage.setItem('period-test-started', 'true'); }
    });
    const rows = [['Old task', '2025-08-01'], ['Old task', '2025-10-01'], ['Ongoing task', '2024-02-29'], ['Ongoing task', '2025-09-01'], ['Ongoing task', '2025-11-05'], ['Ongoing task', '2025-11-06'], ['Ongoing task', '2026-05-01'], ['Ongoing task', '2026-11-04'], ['Ongoing task', '2026-11-05'], ['Ongoing task', '2026-11-06'], ['Ongoing task', '2027-01-01']]
      .map(([title, day], id) => ({ id, title, day, list_title: 'Daily', optional: false, is_completed: true, status: 'completed' }));
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/changes') return route.fulfill({ status: 503, body: '{}' });
      const data = url.pathname === '/api/metrics' ? { revision: '1', modules: [{ id: 'overview', label: 'Overview', kind: 'overview' }, { id: 'task-old', label: 'Old task', kind: 'task', titles: ['Old task'] }, { id: 'task-ongoing', label: 'Ongoing task', kind: 'task', titles: ['Ongoing task'] }] }
        : url.pathname === '/api/consistency' ? rows : [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/metrics?tab=task-ongoing');
    const chart = () => page.frameLocator('#metric-frame');
    const period = async (expected, first, last, count) => {
      await page.waitForFunction(expected => document.querySelector('#metric-frame')?.contentDocument?.querySelector('#heat')?.dataset.period === expected, expected);
      if (expected === '365') {
        assert.equal(await chart().locator('#heat-rolling').getAttribute('aria-pressed'), 'true');
        assert.equal(await chart().locator('#years button.on').count(), 0);
      } else assert.equal(await chart().locator('#years button.on').innerText(), expected);
      if (first) {
        const dates = await chart().locator('#heat [data-day]').evaluateAll(nodes => nodes.map(node => node.dataset.day).sort());
        assert.equal(dates[0], first); assert.equal(dates.at(-1), last); assert.equal(dates.length, count);
        assert.equal(await chart().locator('#heat').getAttribute('data-start'), first);
        assert.equal(await chart().locator('#heat').getAttribute('data-end'), last);
      }
    };
    const rolling = () => period('365', '2025-11-06', '2026-11-05', 365);
    const select = async label => {
      await page.locator('#metric-task-toggle').click();
      const option = page.getByRole('button', { name: label, exact: true });
      if (mobile) await option.tap(); else await option.click();
      await page.locator('#metric-panel[aria-busy=false]').waitFor();
    };
    await rolling();
    await page.locator('#metric-panel[aria-busy=false]').waitFor();
    assert(await chart().locator('.heatscroll').evaluate(async node => { await new Promise(requestAnimationFrame); return node.scrollWidth - node.clientWidth - node.scrollLeft < 2; }), 'Rolling view opens on the latest dates');
    await chart().locator('.heatscroll').evaluate(node => { node.scrollLeft = 0; });
    await page.locator('#metric-frame').evaluate(frame => frame.contentWindow.dispatchEvent(new Event('stellar:report-clock')));
    assert.equal(await chart().locator('.heatscroll').evaluate(async node => { await new Promise(requestAnimationFrame); return node.scrollLeft; }), 0, 'Background clock preserves manual scrolling');
    assert.equal(await chart().locator('[data-day="2025-11-05"]').count(), 0);
    assert.equal(await chart().locator('[data-day="2026-11-06"]').count(), 0);
    await page.locator('#metric-frame').evaluate(frame => { frame.contentWindow.periodTestIdentity = 123; });
    await select('Old task'); await rolling();
    assert((await chart().locator('#heat-year-note').innerText()).includes('No records'), 'Archived tasks do not change the rolling window');
    await select('Ongoing task'); await rolling();
    assert.equal(await page.locator('#metric-frame').evaluate(frame => frame.contentWindow.periodTestIdentity), 123, 'Warm task frames are reused');
    await chart().locator('[data-year="2025"]').click(); await period('2025', '2025-01-01', '2025-12-31', 365);
    await select('Old task'); await rolling();
    await select('Ongoing task'); await rolling();
    await chart().locator('[data-year="2025"]').click();
    await chart().locator('#heat-keep-period').check();
    await select('Old task'); await period('2025');
    await select('Ongoing task'); await period('2025');
    await page.reload(); await period('2025');
    assert(await chart().locator('#heat-keep-period').isChecked(), 'Comparison period survives reopening');
    await chart().locator('#heat-rolling').click(); await rolling();
    assert(await chart().locator('#heat-keep-period').isChecked(), 'Rolling is also a comparison period');
    await select('Old task'); await rolling();
    await select('Ongoing task'); await rolling();
    await chart().locator('[data-year="2026"]').click();
    await select('Old task'); await period('2026');
    assert((await chart().locator('#heat-year-note').innerText()).includes('No records'), 'Empty comparison years remain explicit');
    await chart().locator('#heat-keep-period').uncheck(); await rolling();
    await select('Ongoing task'); await rolling();
    await chart().locator('[data-year="2024"]').click(); await period('2024', '2024-01-01', '2024-12-31', 366);
    assert.equal(await chart().locator('[data-day="2024-02-29"]').count(), 1);
    await chart().locator('#heat-rolling').click(); await rolling();
    await page.locator('#metric-frame').evaluate(frame => { frame.contentWindow.periodTestShift = 86400000; frame.contentWindow.dispatchEvent(new Event('stellar:report-clock')); });
    await period('365', '2025-11-07', '2026-11-06', 365);
    assert(await chart().locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Period controls fit on mobile');
    await page.screenshot({ path: `/private/tmp/metric-periods-${engine}-${mobile ? 'phone' : 'desktop'}.png` });
    await page.locator('#metric-frame').evaluate(frame => { frame.contentWindow.periodTestShift = Date.parse('2024-03-01T20:00:00Z') - Date.parse('2026-11-05T20:00:00Z'); frame.contentWindow.dispatchEvent(new Event('stellar:report-clock')); });
    await period('365', '2023-03-03', '2024-03-01', 365);
    assert.equal(await chart().locator('[data-day="2024-02-29"]').count(), 1, 'Rolling windows include leap day without adding a 366th date');
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await chart().locator('#task').selectOption('Ongoing task'); await rolling();
    await chart().locator('#minocc').evaluate(node => { node.value = '1'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await chart().locator('[data-year="2025"]').click(); await period('2025');
    await chart().locator('.row .name button').filter({ hasText: 'Old task' }).click();
    await rolling();
    assert.deepEqual(errors, []);
    console.log(`${engine} ${mobile ? 'phone' : 'desktop'}: exact 365-day window, calendar/leap years, cached frame reuse, comparison periods, persistence and rollover passed`);
  } finally { await browser.close(); }
}
(async () => { for (const engine of ['chromium', 'webkit']) for (const mobile of [false, true]) await check(engine, mobile); })().catch(error => { console.error(error); process.exit(1); });
