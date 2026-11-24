/* Returning to a retained page must preserve its sky through a failed refresh.
   Visibility is controlled here so the long absence needs no real-time wait. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { forecast, hour, today } = require('../weather_fixture.cjs');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';

async function check(engine) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit })[engine].launch(options);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.clock.setFixedTime(new Date(hour(8) * 1000));
    await page.addInitScript(({ data, at }) => {
      localStorage.setItem('stellar:weather:theme', 'true');
      localStorage.setItem('stellar:weather:place', JSON.stringify({ name: 'Sample City', latitude: 10, longitude: 20 }));
      localStorage.setItem('stellar:weather:forecast', JSON.stringify({ key: '10,20', at, data }));
      let hidden = false;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      window.testVisibility = visible => {
        hidden = !visible;
        document.dispatchEvent(new Event('visibilitychange'));
      };
    }, { data: forecast(), at: hour(8) * 1000 });
    let fail = true, code = 63, reads = 0;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/weather/forecast') {
        reads++;
        return route.fulfill(fail ? { status: 503, json: { detail: 'Weather is temporarily unavailable. Try again.' } }
          : { json: forecast(code) });
      }
      const data = url.pathname.startsWith('/api/day/') ? [] : url.pathname === '/api/pool' ? { tasks: [], edges: [] } : { days: {} };
      return route.fulfill({ json: data });
    });
    await page.goto(base + '/?day=' + today, { waitUntil: 'domcontentloaded' });
    const sky = page.locator('body > .space-backdrop .weather-scene.is-current');
    await sky.waitFor();
    const original = await sky.elementHandle();
    assert.equal(reads, 0, 'A fresh cached forecast needs no startup read');
    await page.evaluate(() => window.testVisibility(false));
    await page.clock.setFixedTime(new Date(hour(9) * 1000));
    assert.equal(reads, 0, 'The hidden page does not poll weather');
    const failed = page.waitForResponse(response => response.url().includes('/api/weather/forecast'));
    await page.evaluate(() => {
      window.testVisibility(true);
      window.dispatchEvent(new Event('pageshow'));
      window.dispatchEvent(new Event('focus'));
    });
    await failed;
    await page.waitForFunction(() => window.stellarWeatherRequests?.failures.size === 1);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await original.evaluate(el => el.isConnected && el.classList.contains('is-current')),
      'A failed resume refresh must retain the last known weather sky instead of exposing the starfield');
    assert.equal(reads, 1, 'Resume events share one request');
    await page.locator('#weather-open').click();
    const dialog = page.getByRole('dialog', { name: 'Weather' });
    await page.waitForFunction(() => document.querySelector('[data-forecast-status]')?.textContent.includes('last available forecast'));
    assert.match(await dialog.locator('[data-forecast-status]').textContent(), /last available forecast/);
    fail = false;
    await dialog.locator('[data-retry]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('stellar:weather:forecast'))?.at === Date.now());
    assert(await original.evaluate(el => el.isConnected && el.classList.contains('is-current')),
      'Recovery with unchanged weather keeps the same sky');
    code = 0;
    await page.clock.setFixedTime(new Date(hour(9.5) * 1000));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.locator('body > .space-backdrop [data-scene=sun].is-current').waitFor();
    assert.deepEqual(errors, []);
    console.log(engine + ': resume failure preserves sky, recovery retains it, changed conditions update it');
  } finally { await browser.close(); }
}

Promise.allSettled([check('chromium'), check('webkit')]).then(results => {
  for (const result of results) {
    if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
  }
});
