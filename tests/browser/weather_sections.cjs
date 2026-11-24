/* Synthetic cached forecasts exercise the one app-wide sky across retained
   sections, direct launches, city changes, failures and narrow layouts. The sky
   must preserve its node and animation phase without extra forecast/task reads. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { forecast, hour, today } = require('../weather_fixture.cjs');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
async function check(engine, mobile) {
  const browser = await ({ chromium, webkit })[engine].launch(engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
  try {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      serviceWorkers: 'block', isMobile: mobile, hasTouch: mobile });
    await context.addInitScript(({ data, at }) => {
      const D = Date, offset = at - D.now();
      window.Date = class extends D {
        constructor(...args) { super(...(args.length ? args : [D.now() + offset])); }
        static now() { return D.now() + offset; }
      };
      if (!localStorage.getItem('weather-test-seeded')) {
        localStorage.setItem('weather-test-seeded', 'true');
        localStorage.setItem('stellar:weather:theme', 'true');
        localStorage.setItem('stellar:weather:place', JSON.stringify({ name: 'Sample City', latitude: 10, longitude: 20 }));
        localStorage.setItem('stellar:weather:forecast', JSON.stringify({ key: '10,20', at, data }));
      }
    }, { data: forecast(0), at: hour(8) * 1000 });
    const requests = [], errors = [], images = [];
    let delayForecast, fail = false;
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url()); requests.push(url.pathname);
      let data = [];
      if (url.pathname === '/api/weather/forecast') {
        if (delayForecast) await delayForecast;
        return route.fulfill(fail ? { status: 503, json: { detail: 'Forecast temporarily unavailable' } } : { json: forecast(63) });
      }
      if (url.pathname === '/api/metrics') data = { revision: '1', modules: [{ id: 'overview', label: 'Overview', kind: 'overview' }] };
      else if (url.pathname === '/api/task_history') data = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, title: i % 2 ? 'Read a chapter' : 'Run', list_title: 'Daily', day: today, status: i % 3 ? 'completed' : 'incomplete', is_completed: i % 3 !== 0, optional: false, notes: '' }));
      else if (url.pathname === '/api/range') data = { days: {} };
      else if (url.pathname === '/api/pool') data = { tasks: [], edges: [] };
      else if (url.pathname === '/api/calendar/events') data = { events: [] };
      else if (url.pathname === '/api/changes') data = { records: '1', definitions: '1', pool: '1' };
      return route.fulfill({ json: data });
    });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/weather-.*\.jpg/.test(r.url())) images.push(r.url()); });
    await page.goto(base + '/metrics');
    const sky = page.locator('body > .space-backdrop > .weather-scene.is-current');
    await sky.waitFor();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.stellar-weather-backdrop .is-current')).opacity) > .99);
    const original = await sky.elementHandle();
    assert.equal(requests.filter(p => p.startsWith('/api/weather')).length, 0, 'Cached direct Metrics launch reads no weather API');
    assert.equal(requests.filter(p => /range|\/day\//.test(p)).length, 0, 'The ambient sky does not load task ranges');
    assert.deepEqual(images.map(u => new URL(u).pathname), ['/app-assets/weather-fair.jpg']);
    const click = async label => {
      if (mobile) await page.locator('.nav-toggle').click();
      await page.locator('.sidenav .nav-links a').filter({ hasText: label }).click();
    };
    const frameFor = async path => {
      await page.waitForFunction(path => [...document.querySelectorAll('iframe.stellar-section')].some(f => !f.hidden && f.contentDocument?.body?.dataset.page === path), path);
      return page.frames().find(f => (path === 'today' ? ['/', '/today'].includes(new URL(f.url()).pathname) : new URL(f.url()).pathname === '/' + path) && f.url().includes('tab_frame'));
    };
    let phase = await original.evaluate(el => el.getAnimations({ subtree: true }).find(a => a.animationName === 'weather-drift').currentTime);
    for (const [label, path] of [['Activity', 'data'], ['Settings', 'tasks'], ['Calendar', 'calendar'], ['API', 'docs'], ['Space', '']]) {
      await click(label);
      const frame = await frameFor(path || 'today');
      await frame.waitForFunction(() => document.documentElement.hasAttribute('data-weather-shared'));
      await frame.locator('body > .wrap, body > #swagger-ui').first().waitFor();
      if (path === 'data') await frame.locator('tbody tr').first().waitFor();
      if (mobile) {
        const nav = await page.locator('.sidenav').boundingBox();
        const heading = await frame.locator('h1, .swagger-ui .info .title').first().boundingBox();
        assert(heading.y >= nav.y + nav.height, 'Retained page headings stay below the mobile header');
      }
      assert.equal(await frame.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)', 'The active section exposes the shared sky');
      assert(await original.evaluate(el => el === document.querySelector('.stellar-weather-backdrop .is-current')), 'Switching preserves the sky node');
      await page.waitForFunction(() => document.querySelector('.stellar-weather-backdrop').dataset.weatherMotion === 'running');
      const next = await original.evaluate(el => el.getAnimations({ subtree: true }).find(a => a.animationName === 'weather-drift').currentTime);
      assert(next >= phase, 'Switching preserves animation time'); phase = next;
      assert.equal(await sky.count(), 1);
      assert.equal(requests.filter(p => p === '/api/weather/forecast').length, 0, 'Tab changes reuse the forecast');
      if (['data', 'calendar'].includes(path)) await page.screenshot({ path: `/private/tmp/stellar-weather-${path}-${engine}-${mobile ? 'mobile' : 'desktop'}.png` });
    }
    await click('Metrics');
    assert(await original.evaluate(el => el.isConnected), 'Returning to the initial section retains the sky');
    await page.goto(base + '/calendar');
    await sky.waitFor();
    assert.equal(requests.filter(p => p === '/api/weather/forecast').length, 0, 'Calendar and ambient cached startup share data');
    delayForecast = new Promise(resolve => { check.release = resolve; });
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('stellar:weather:forecast')); saved.at -= 20 * 60000;
      localStorage.setItem('stellar:weather:forecast', JSON.stringify(saved));
    });
    const pending = page.waitForRequest('**/api/weather/forecast?**');
    await page.reload(); await pending;
    await page.locator('body > .wrap').waitFor();
    assert.equal(requests.filter(p => p === '/api/weather/forecast').length, 1, 'Calendar and ambient stale startup share one in-flight request');
    check.release(); delayForecast = null;
    await page.locator('.stellar-weather-backdrop [data-scene=rain].is-current').waitFor();
    const rainy = await sky.elementHandle();
    fail = true;
    await page.evaluate(() => {
      const now = Date.now; Date.now = () => now() + 20 * 60000;
      window.dispatchEvent(new Event('stellar:weather-change'));
    });
    await page.waitForFunction(() => window.stellarWeatherRequests.failures.size === 1);
    assert(await rainy.evaluate(el => el.isConnected && el.classList.contains('is-current')), 'Failed refresh keeps the last known sky');
    const second = await context.newPage(); await second.goto(base + '/tasks');
    await second.locator('.stellar-weather-backdrop .is-current').waitFor();
    await page.evaluate(() => {
      localStorage.setItem('stellar:weather:theme', 'false');
      window.dispatchEvent(new Event('stellar:weather-change'));
    });
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-weather-backdrop'));
    await second.waitForFunction(() => !document.documentElement.hasAttribute('data-weather-backdrop'));
    assert.deepEqual(errors, []);
    console.log(`${engine} ${mobile ? 'mobile' : 'desktop'}: all sections share a continuous sky, cached/stale direct launches, one forecast request, failure retention and cross-window toggle passed`);
  } finally { await browser.close(); }
}
(async () => { for (const [engine, mobile] of [['chromium', false], ['webkit', true]]) await check(engine, mobile); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
