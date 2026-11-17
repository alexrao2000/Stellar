/* Location selection survives reopening and reloads. Browser requests are
   confined to Stellar, including when forecast loading fails and is retried. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { forecast, today } = require('../weather_fixture.cjs');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';

async function check(engine) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit })[engine].launch(options);
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.clock.setFixedTime(new Date('2026-11-16T16:00:00Z'));
    let fail = true, searches = 0;
    const forecasts = [], external = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (new URL(request.url()).origin !== new URL(base).origin) external.push(request.url());
    });
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let data = {};
      if (url.pathname === '/api/weather/forecast') {
        forecasts.push(url.searchParams.get('latitude'));
        if (fail) return route.fulfill({ status: 503, json: { detail: 'Weather is temporarily unavailable. Try again.' } });
        data = forecast(2);
      } else if (url.pathname === '/api/weather/cities') {
        searches++;
        data = { results: [{ name: 'Sample City', admin1: 'Example Region', country: 'Example Country', latitude: 10, longitude: 20 }] };
      } else if (url.pathname === '/api/range') {
        data = { days: {} };
      } else if (url.pathname.startsWith('/api/day/')) {
        data = [];
      }
      return route.fulfill({ json: data });
    });
    await page.goto(base + '/?day=' + today, { waitUntil: 'domcontentloaded' });
    await page.locator('#weather-open').tap();
    const dialog = page.getByRole('dialog', { name: 'Weather' });
    const defaults = dialog.getByRole('group', { name: 'Defaults' });
    await defaults.getByRole('button', { name: /^Fremont/ }).tap();
    await dialog.locator('[data-retry]').waitFor();
    assert.match(await dialog.locator('[data-forecast-status]').textContent(), /temporarily unavailable/);
    fail = false;
    await dialog.locator('[data-retry]').tap();
    await dialog.locator('[data-temp]').waitFor();
    assert.equal(await dialog.locator('[data-place]').textContent(), 'Fremont');
    assert.equal(searches, 0, 'Defaults open directly without city search');
    await dialog.getByRole('button', { name: 'Cities', exact: true }).tap();
    await dialog.getByRole('group', { name: 'Recently used' }).getByRole('button', { name: /^Fremont/ }).waitFor();
    await dialog.getByRole('searchbox').fill('Sample City');
    await dialog.getByRole('button', { name: 'Search', exact: true }).tap();
    await dialog.locator('.weather-results').getByRole('button', { name: /Sample City/ }).tap();
    await page.waitForFunction(() => document.querySelector('[data-place]')?.textContent === 'Sample City');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#weather-open').tap();
    await page.waitForFunction(() => document.querySelector('[data-place]')?.textContent === 'Sample City');
    assert.equal(searches, 1, 'The last city is restored without repeating the search');
    await dialog.getByRole('button', { name: 'Cities', exact: true }).tap();
    const recents = dialog.getByRole('group', { name: 'Recently used' });
    assert.deepEqual(await recents.locator('strong').allTextContents(), ['Sample City', 'Fremont']);
    await recents.getByRole('button', { name: /^Fremont/ }).tap();
    await page.waitForFunction(() => document.querySelector('[data-place]')?.textContent === 'Fremont');
    assert.equal(searches, 1);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await dialog.getByRole('button', { name: 'Cities', exact: true }).tap();
      assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await dialog.getByRole('group', { name: 'Defaults' }).getByRole('button', { name: /^Los Angeles/ }).tap();
      await page.waitForFunction(() => document.querySelector('[data-place]')?.textContent === 'Los Angeles');
    }
    await dialog.getByRole('button', { name: 'Cities', exact: true }).tap();
    for (const name of await dialog.locator('.weather-city-list strong').all()) {
      assert((await name.boundingBox()).width >= 90, 'City names have a full row inside the card');
    }
    await page.screenshot({ path: '/private/tmp/stellar-weather-cities-' + engine + '.png' });
    assert(forecasts.length >= 4);
    assert.deepEqual(external, [], 'Weather uses only the app origin');
    assert.deepEqual(errors, []);
    console.log(engine + ': mobile forecast retry, defaults, recent cities, persistence and same-origin requests passed');
  } finally { await browser.close(); }
}

(async () => { for (const engine of ['chromium', 'webkit']) await check(engine); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
