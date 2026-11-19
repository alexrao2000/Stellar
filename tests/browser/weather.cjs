/* Test the weather panel with a rainy day that has one sunny pre-deadline
   window. Close controls must survive forecast/city scrolling and a shrinking
   viewport. No requests use a real location or backend record. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { forecast, hour, records, today } = require('../weather_fixture.cjs');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';

async function check(engine, mobile) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit })[engine].launch(options);
  try {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.clock.setFixedTime(new Date(hour(8) * 1000));
    const errors = [], requests = [], byDay = records();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.url().includes('/app-assets/weather') || request.url().includes('open-meteo.com')) requests.push(request.url());
    });
    let code = 63;
    let releaseForecast;
    const firstForecast = new Promise(resolve => { releaseForecast = resolve; });
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let data = {};
      if (url.pathname === '/api/weather/forecast') {
        await firstForecast;
        data = forecast(code);
      } else if (url.pathname === '/api/weather/cities') {
        data = { results: [{ name: 'Los Angeles', admin1: 'California', country: 'United States', latitude: 34.05, longitude: -118.24 }] };
      } else if (url.pathname === '/api/range') {
        const days = {};
        const end = new Date(url.searchParams.get('end') + 'T12:00:00Z');
        for (let date = new Date(url.searchParams.get('start') + 'T12:00:00Z'); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
          const key = date.toISOString().slice(0, 10);
          days[key] = byDay[key] || [];
        }
        data = { days };
      } else if (url.pathname.startsWith('/api/day/')) {
        data = byDay[url.pathname.split('/').at(-1)] || [];
      } else if (url.pathname === '/api/pool') {
        data = { tasks: [{ id: '1', title: 'A pool star', x: .7, y: .4, status: 'open' }], edges: [] };
      }
      await route.fulfill({ json: data });
    });

    await page.goto(base + '/?day=' + today, { waitUntil: 'domcontentloaded' });
    await page.locator('#tasks .task').first().waitFor();
    assert.equal(requests.length, 0, 'Weather stays off the startup path before it is enabled');
    const trigger = page.locator('#weather-open');
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Weather' });
    await dialog.getByRole('searchbox').fill('Los Angeles');
    await dialog.getByRole('button', { name: 'Search', exact: true }).click();
    const taskRead = page.waitForRequest(request => request.url().includes('/api/range?start=2026-11-16&end=2026-11-24'));
    await dialog.locator('.weather-results').getByRole('button', { name: /Los Angeles/ }).click();
    await taskRead;
    assert.equal(requests.filter(url => url.includes('.jpg')).length, 0, 'The task read starts before the forecast and artwork are available');
    releaseForecast();

    await dialog.locator('.weather-dialog-sky [data-scene=rain][data-phase=day].is-current').waitFor({ state: 'attached' });
    const originalRain = await dialog.locator('.weather-dialog-sky .is-current').elementHandle();
    assert.deepEqual([...new Set(requests.filter(url => url.includes('.jpg')).map(url => new URL(url).pathname))],
      ['/app-assets/weather-storm.jpg']);
    await page.waitForFunction(() => document.querySelector('[data-task]')?.value === 'Run');
    assert.match(await dialog.locator('.weather-condition').textContent(), /Rain/);
    assert.match(await dialog.locator('.weather-solar').textContent(), /Sunset 5:00/);
    assert.match(await dialog.locator('.weather-hourly').evaluate(el => getComputedStyle(el).backdropFilter), /blur/);
    assert.match(await dialog.locator('.weather-window-time').textContent(), /10:00.*10:45/);
    assert.match(await dialog.locator('.weather-window').textContent(), /Sunny window.*10% precipitation chance.*peaks at a 90%/s);
    assert.equal(await dialog.locator('.weather-date').count(), 7);
    for (const width of mobile ? [320, 390] : [1440]) {
      if (mobile) await page.setViewportSize({ width, height: 844 });
      const sizes = await dialog.evaluate(el => [el.scrollWidth, el.clientWidth]);
      assert(sizes[0] <= sizes[1] + 1, `${width}px: only the hour and date strips scroll sideways (${sizes.join('/')})`);
      await page.setViewportSize({ width, height: 320 });
      const close = dialog.getByRole('button', { name: 'Close weather' });
      const before = await close.boundingBox();
      const scroller = dialog.locator('.weather-shell');
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert(await scroller.evaluate(el => el.scrollTop > 0), 'The forecast actually scrolls');
      await dialog.locator('.weather-footer a').last().focus();
      await page.keyboard.press('End');
      await dialog.evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.equal(await dialog.evaluate(el => el.scrollTop), 0, 'The outer modal never scrolls its header');
      const after = await close.boundingBox();
      assert(Math.abs(after.y - before.y) < 1, 'Close stays anchored when the forecast scrolls');
      assert(after.y >= 0 && after.y + after.height <= 320, 'Close remains within a short viewport');
      assert(await close.evaluate(el => {
        const bounds = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      }), 'Close overlays the forecast and remains clickable');
      await close.click();
      assert.equal(await dialog.count(), 0, 'Close works at the bottom of the forecast');
      await trigger.click();
      await dialog.getByRole('button', { name: 'Cities', exact: true }).click();
      await dialog.getByRole('searchbox').focus();
      await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert(await scroller.evaluate(el => el.scrollTop > 0), 'The city picker actually scrolls');
      assert(Math.abs((await close.boundingBox()).y - before.y) < 1, 'The city picker keeps the same close-button position');
      await close.click();
      await trigger.click();
      await dialog.locator('.weather-city-list .weather-city').first().click();
      await scroller.evaluate(el => { el.scrollTop = 0; });
      await page.setViewportSize({ width, height: mobile ? 844 : 1000 });
    }
    await dialog.locator('.weather-date[data-day="2026-11-17"]').click();
    assert.match(await dialog.locator('.weather-window').textContent(), /Task complete/);
    await dialog.locator('.weather-date[data-day="2026-11-16"]').click();
    await dialog.getByRole('combobox', { name: 'Duration' }).selectOption('90');
    assert.match(await dialog.locator('.weather-window').textContent(), /No dry window found/);
    await dialog.getByRole('combobox', { name: 'Duration' }).selectOption('45');
    await page.screenshot({ path: '/private/tmp/stellar-weather-' + (mobile ? 'mobile' : 'desktop') + '-' + engine + '.jpg', type: 'jpeg', quality: 87 });

    await dialog.getByLabel('Use in Space').check();
    const backdrop = page.locator('body > .space-backdrop > .weather-scene');
    await backdrop.and(page.locator('[data-scene=rain].is-current')).waitFor();
    const spacePanel = page.locator('.wrap:not(.workspace-open), .workspace-open > .dated-tasks');
    assert.match(await spacePanel.evaluate(el => getComputedStyle(el).backdropFilter), /blur/);
    assert.equal(await backdrop.first().evaluate(el => getComputedStyle(el, '::before').animationPlayState), 'paused', 'Space pauses behind the weather modal');
    assert.equal(await backdrop.locator('.weather-rain-depth').evaluate(el => getComputedStyle(el).animationPlayState), 'paused');
    if (!mobile) {
      const root = page.frameLocator('#pool-frame').locator('html');
      assert.equal(await root.getAttribute('data-weather-backdrop'), '');
      await page.frameLocator('#pool-frame').locator('.star[data-id="1"] .hit').waitFor();
    }
    await dialog.getByRole('button', { name: 'Close weather' }).click();
    await page.waitForFunction(() => document.querySelector('body > .space-backdrop').dataset.weatherMotion === 'running');
    assert.equal(await page.locator('.weather-dialog-sky .is-current').evaluate(el => getComputedStyle(el, '::after').animationPlayState), 'paused', 'The closed dialog retains its scene without animating it');
    await page.evaluate(() => {
      window.testPageActive = window.stellarPageActive;
      window.stellarPageActive = () => false;
      window.dispatchEvent(new Event('stellar:visibility'));
    });
    const sceneTime = await backdrop.first().evaluate(el => {
      const state = getComputedStyle(el, '::before').animationPlayState;
      return { state, time: el.getAnimations({ subtree: true }).find(a => a.animationName === 'weather-drift').currentTime };
    });
    assert.equal(sceneTime.state, 'paused', 'Leaving Space pauses the retained sky');
    await page.evaluate(() => {
      window.stellarPageActive = window.testPageActive;
      delete window.testPageActive;
      window.dispatchEvent(new Event('stellar:visibility'));
    });
    assert(await backdrop.first().evaluate(el => el.getAnimations({ subtree: true }).find(a => a.animationName === 'weather-drift').currentTime) >= sceneTime.time,
      'Returning to Space resumes the existing animation phase');
    const unchanged = page.waitForResponse(response => response.url().includes('/api/weather/forecast'));
    await page.clock.setFixedTime(new Date((hour(8) + 16 * 60) * 1000));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await unchanged;
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('stellar:weather:forecast'))?.at === Date.now());
    await trigger.click();
    assert(await originalRain.evaluate(el => document.querySelector('.weather-dialog-sky .is-current') === el),
      'Refreshes, planner selections and reopening retain the same sky when current conditions are unchanged');
    await dialog.getByRole('button', { name: 'Close weather' }).click();
    code = 0;
    await page.clock.setFixedTime(new Date((hour(8) + 32 * 60) * 1000));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const sunnyScene = backdrop.and(page.locator('[data-scene=sun].is-current'));
    await sunnyScene.waitFor();
    assert.equal(await sunnyScene.evaluate(el => getComputedStyle(el, '::before').animationName), 'weather-drift');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await sunnyScene.evaluate(el => getComputedStyle(el, '::before').animationName), 'none');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sunnyScene.waitFor();
    assert.equal(await dialog.count(), 0, 'The weather backdrop persists independently of the dialog');

    await trigger.click();
    await dialog.getByRole('button', { name: 'Open tasks', exact: true }).click();
    await page.locator('#tasks .task').first().waitFor();
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.locator('#pick').inputValue(), today);
    await trigger.click();
    for (const [time, phase, scene] of [
      [hour(16.75), 'dusk', 'sun'], [hour(18), 'night', 'night'],
      [hour(19), 'night', 'rain'], [hour(6.75, 1), 'dawn', 'rain'], [hour(8, 1), 'day', 'rain'],
    ]) {
      if (time === hour(19)) code = 63;
      await page.clock.setFixedTime(new Date(time * 1000));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const selector = '[data-phase=' + phase + '][data-scene=' + scene + '].is-current';
      await dialog.locator('.weather-dialog-sky ' + selector).waitFor({ state: 'attached' });
      await backdrop.and(page.locator(selector)).waitFor({ state: 'attached' });
      if (time === hour(18)) {
        await page.screenshot({ path: '/private/tmp/stellar-weather-night-' + engine + '.jpg', type: 'jpeg', quality: 87 });
      }
    }
    await dialog.getByLabel('Use in Space').uncheck();
    await backdrop.first().waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    console.log(engine + (mobile ? ' phone' : ' desktop') + ': forecast, glass, planner, day/night cycles and reduced motion passed');
  } finally { await browser.close(); }
}

Promise.allSettled([check('chromium', false), check('webkit', true)]).then(results => {
  for (const result of results) {
    if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
  }
});
