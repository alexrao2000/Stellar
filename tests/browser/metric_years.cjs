/* Demo-only year navigation covers cached task frames, archived/current data,
   the comparison lock, persistence, empty comparison years, and mobile layout. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
async function check(engine, mobile) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit }[engine]).launch(options);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile });
    await context.addInitScript(() => {
      const D = Date, offset = D.parse('2026-11-05T20:00:00Z') - D.now();
      window.Date = class extends D { constructor(...args) { super(...(args.length ? args : [D.now() + offset])); } static now() { return D.now() + offset; } };
      if (!localStorage.getItem('year-test-started')) { localStorage.setItem('stellar:heat-year', '2025'); localStorage.setItem('year-test-started', 'true'); }
    });
    const rows = [['Old task', '2025-08-01'], ['Old task', '2025-10-01'], ['Ongoing task', '2025-09-01'], ['Ongoing task', '2026-05-01'], ['Ongoing task', '2026-11-04'], ['Ongoing task', '2027-01-01']]
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
    const year = async expected => {
      await page.waitForFunction(expected => document.querySelector('#metric-frame')?.contentDocument?.querySelector('#heat')?.dataset.year === expected, expected).catch(async error => {
        console.error({ engine, mobile, expected, errors, state: await page.evaluate(() => { const frame = document.querySelector('#metric-frame'), doc = frame?.contentDocument; return { selected: document.querySelector('#metric-task-label')?.textContent, status: document.querySelector('#metric-status')?.textContent, url: frame?.contentWindow.location.href, year: doc?.querySelector('#heat')?.dataset.year, note: doc?.querySelector('#heat-year-note')?.textContent, ready: doc?.body.dataset.metricReady }; }) });
        throw error;
      });
      assert.equal(await chart().locator('#years button.on').innerText(), expected);
    };
    const select = async label => {
      await page.locator('#metric-task-toggle').click();
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.locator('#metric-panel[aria-busy=false]').waitFor();
    };
    await year('2026');
    await page.locator('#metric-frame').evaluate(frame => { frame.contentWindow.yearTestIdentity = 123; });
    await select('Old task'); await year('2025');
    await select('Ongoing task'); await year('2026');
    assert.equal(await page.locator('#metric-frame').evaluate(frame => frame.contentWindow.yearTestIdentity), 123, 'Warm task frames are reused');
    await chart().locator('[data-year="2025"]').click(); await year('2025');
    await select('Old task'); await year('2025');
    await select('Ongoing task'); await year('2026');
    await chart().locator('[data-year="2025"]').click();
    await chart().locator('#heat-keep-year').check();
    await select('Old task'); await year('2025');
    await select('Ongoing task'); await year('2025');
    await page.reload(); await year('2025');
    assert(await chart().locator('#heat-keep-year').isChecked(), 'Comparison preference survives reopening');
    await chart().locator('#heat-latest').click(); await year('2026');
    assert(!(await chart().locator('#heat-keep-year').isChecked()));
    await chart().locator('#heat-keep-year').check();
    await select('Old task'); await year('2026');
    assert((await chart().locator('#heat-year-note').innerText()).includes('No records'), 'Locked empty years are explicit');
    await chart().locator('#heat-keep-year').uncheck(); await year('2025');
    await select('Ongoing task'); await year('2026');
    assert(await chart().locator('body').evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Year controls fit on mobile');
    await page.screenshot({ path: `/private/tmp/metric-years-${engine}-${mobile ? 'phone' : 'desktop'}.png` });
    assert.deepEqual(errors, []);
    console.log(`${engine} ${mobile ? 'phone' : 'desktop'}: latest per task, cached frame reuse, comparison lock, persistence and empty years passed`);
  } finally { await browser.close(); }
}
(async () => { for (const engine of ['chromium', 'webkit']) for (const mobile of [false, true]) await check(engine, mobile); })().catch(error => { console.error(error); process.exit(1); });
