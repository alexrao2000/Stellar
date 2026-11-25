/* Calendar journeys use synthetic events and forecasts. Verify that weather
   does not block events, suggestions book only on confirmation, task records
   stay untouched, and the retained calendar and mobile editor remain usable. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { forecast, hour, records, today } = require('../weather_fixture.cjs');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';

async function check(engine, mobile) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit })[engine].launch(options);
  try {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
    await context.addInitScript(() => localStorage.setItem('stellar:weather:place', JSON.stringify({ name: 'Sample City', latitude: 10, longitude: 20 })));
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    await page.clock.setFixedTime(new Date(hour(8) * 1000));
    const errors = [], documents = [], mutations = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (req.resourceType() === 'document') documents.push(req.url()); if (req.method() !== 'GET') mutations.push(new URL(req.url()).pathname); });
    const byDay = records(); byDay['2026-11-17'][0].is_completed = false;
    let revision = 1, sequence = 0;
    const makeEvent = (id, title, start, end, extra = {}) => ({ id, title, starts_at: new Date(start * 1000).toISOString(), ends_at: new Date(end * 1000).toISOString(),
      notes: '', all_day: false, kind: 'event', task_title: null, run_day: null, time_zone: 'America/Los_Angeles', updated_at: '2026-11-16T16:00:00.000Z', ...extra });
    let stored = [makeEvent('00000000-0000-0000-0000-000000000001', 'Planning session', hour(9), hour(10))];
    let releaseWeather; const pendingWeather = new Promise(resolve => { releaseWeather = resolve; });
    await context.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.pathname === '/api/weather/forecast') { await pendingWeather; return route.fulfill({ json: forecast() }); }
      if (url.pathname === '/api/calendar/external-events') return route.fulfill({ json: { events: [], complete: true, errors: [], connections: [] } });
      if (url.pathname === '/api/calendar/task-planning') return route.fulfill({ json: { tasks: [{ series_id: 1, title: 'Run', titles: ['Run'], starts_on: today,
        rule: { enabled: true, duration_minutes: 10, earliest: 420, latest: 1260, weather: 'dry', daylight_only: true, min_temperature_c: 2, max_temperature_c: 30, max_rain_percent: 30, max_wind_kph: 40, buffer_minutes: 0 } }] } });
      if (url.pathname.startsWith('/api/calendar/events')) {
        if (req.method() === 'GET') return route.fulfill({ json: { events: stored }, headers: { ETag: '"' + revision + '"' } });
        if (req.method() === 'DELETE') { const id = url.pathname.split('/').at(-1); stored = stored.filter(row => row.id !== id); revision++; return route.fulfill({ json: { deleted: id } }); }
        const body = req.postDataJSON(), id = req.method() === 'PUT' ? url.pathname.split('/').at(-1) : body.id;
        const next = { ...body, id, updated_at: `2026-11-16T16:00:${String(++sequence).padStart(2, '0')}.000Z` };
        stored = [...stored.filter(row => row.id !== id), next]; revision++;
        return route.fulfill({ json: next });
      }
      if (url.pathname === '/api/range') return route.fulfill({ json: { days: byDay } });
      if (url.pathname.startsWith('/api/day/')) return route.fulfill({ json: byDay[today] });
      if (url.pathname === '/api/pool') return route.fulfill({ json: { tasks: [], edges: [] } });
      return route.fulfill({ json: {} });
    });
    await page.goto(base + '/calendar?day=' + today + '&view=week', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Planning session/ }).waitFor();
    assert.equal(await page.locator('.cal-event.is-suggestion').count(), 0, 'Events appear before forecast completion');
    releaseWeather();
    await page.locator(`.cal-event[data-slot="${hour(10)}"]`).waitFor();
    assert.equal(await page.locator('.cal-day-column[data-day="2026-11-17"] .is-suggestion').count(), 3);
    assert.equal(mutations.length, 0, 'Recommendations do not write any reservations');
    await page.locator(`.cal-event[data-slot="${hour(10)}"]`).click();
    const run = page.getByRole('dialog', { name: 'Run', exact: true });
    assert.equal(stored.length, 1);
    await run.getByRole('button', { name: 'Schedule Run' }).click();
    await run.waitFor({ state: 'hidden' });
    assert.equal(stored.filter(row => row.kind === 'task').length, 1);
    assert.equal(Date.parse(stored.at(-1).ends_at) - Date.parse(stored.at(-1).starts_at), 600000);
    assert.equal(await page.locator(`.cal-day-column[data-day="${today}"] .is-suggestion`).count(), 0);
    await page.locator('.cal-event[data-kind=task]').first().click();
    const editor = page.getByRole('dialog', { name: 'Edit event' });
    await editor.getByLabel('Start', { exact: true }).fill('10:15');
    await editor.getByRole('button', { name: 'Save event' }).click();
    await editor.waitFor({ state: 'hidden' });
    assert.equal(Date.parse(stored.find(row => row.kind === 'task').starts_at) / 1000, hour(10.25));
    await page.getByRole('button', { name: '＋ Add event' }).click();
    const create = page.getByRole('dialog', { name: 'New event' });
    await create.getByLabel('Title', { exact: true }).fill('An all-day event with a long readable name');
    await create.getByLabel('Date', { exact: true }).fill('2026-11-18');
    await create.getByLabel('All day', { exact: true }).check();
    await create.getByRole('button', { name: 'Save event' }).click();
    await create.waitFor({ state: 'hidden' });
    assert.equal(stored.length, 3);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.cal-event[data-kind=task]').first().waitFor();
    await page.getByRole('button', { name: 'Wednesday, Nov 18', exact: true }).click();
    if (mobile) await page.locator('#cal-mobile-all-day .cal-event').waitFor();
    for (const width of mobile ? [320, 390] : [1440]) {
      await page.setViewportSize({ width, height: mobile ? 844 : 1000 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px: the calendar stays within the viewport`);
      await page.getByRole('button', { name: '＋ Add event' }).click();
      await create.getByLabel('Title', { exact: true }).fill('Another event');
      await create.getByLabel('Start', { exact: true }).fill('11:00');
      const bounds = await create.evaluate(dialog => {
        const box = dialog.getBoundingClientRect();
        return [...dialog.querySelectorAll('input,select,textarea')].filter(el => el.getClientRects().length).every(el => {
          const r = el.getBoundingClientRect(); return r.left >= box.left && r.right <= box.right && el.clientWidth >= (el.type === 'checkbox' ? 12 : 30);
        });
      });
      assert(bounds, `${width}px: native date/time controls stay inside the dialog`);
      await page.screenshot({ path: `/private/tmp/stellar-calendar-editor-${engine}-${width}.png` });
      await create.getByRole('button', { name: 'Close event' }).click();
    }
    await page.screenshot({ path: `/private/tmp/stellar-calendar-${engine}.png` });
    assert(mutations.every(path => path.startsWith('/api/calendar/events')), 'Booking never completes a task or writes to an external calendar');
    await page.getByRole('button', { name: 'Monday, Nov 16', exact: true }).click();
    await page.getByRole('button', { name: /Planning session/ }).click();
    await editor.getByRole('button', { name: 'Remove event' }).click();
    await editor.waitFor({ state: 'hidden' });
    assert(!stored.some(event => event.title === 'Planning session'));
    const calendarLoads = documents.filter(url => new URL(url).pathname === '/calendar').length;
    await page.evaluate(() => window.stellarNavigate(new URL('/', location.origin)));
    const space = page.frameLocator('iframe.stellar-section[title="Space · Stellar"]');
    await space.locator('#tasks').waitFor();
    await space.locator('#weather-open').click();
    await space.locator('[data-place]').filter({ hasText: /^Sample City$/ }).waitFor();
    await page.evaluate(() => window.stellarNavigate(new URL('/calendar', location.origin)));
    await page.locator('.calendar-app').waitFor();
    assert.equal(documents.filter(url => new URL(url).pathname === '/calendar').length, calendarLoads, 'Returning to Calendar reuses its document');
    if (mobile) await page.locator('#cal-location').tap(); else await page.locator('#cal-location').click();
    if (mobile) await page.locator('#cal-cities').getByRole('button', { name: /Fremont/ }).tap();
    else await page.locator('#cal-cities').getByRole('button', { name: /Fremont/ }).click();
    await page.evaluate(() => window.stellarNavigate(new URL('/', location.origin)));
    await space.locator('[data-place]').filter({ hasText: /^Fremont$/ }).waitFor();
    await page.evaluate(() => window.stellarNavigate(new URL('/calendar', location.origin)));
    assert.deepEqual(errors, []);
    console.log(engine + ': lazy forecast, marked alternatives, booking, editing, persistence, all-day events and responsive forms passed');
  } catch (error) {
    console.error(engine + ': calendar journey failed', error.message);
    throw error;
  } finally { await browser.close(); }
}

Promise.allSettled([check('chromium', false), check('webkit', true)]).then(results => {
  for (const result of results) if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
});
