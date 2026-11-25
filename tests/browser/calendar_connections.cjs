/* Synthetic Google/Outlook calendars exercise explicit permissions, read-only
   views, native event writes, task settings and narrow-screen modal controls.
   No requests reach a provider or a real calendar account. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { today, hour } = require('../weather_fixture.cjs');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
async function check(engine, mobile) {
  const browser = await ({ chromium, webkit })[engine].launch(engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
  try {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, serviceWorkers: 'block' });
    await context.addInitScript(at => {
      const D = Date, offset = at - D.now(); window.Date = class extends D { constructor(...args) { super(...(args.length ? args : [D.now() + offset])); } static now() { return D.now() + offset; } };
    }, hour(8) * 1000);
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], writes = [];
    page.on('pageerror', e => errors.push(e.message));
    let releaseExternal, complete = true;
    const externalWait = new Promise(resolve => { releaseExternal = resolve; });
    const connections = [
      { id: '00000000-0000-0000-0000-000000000011', provider: 'google', mode: 'read', selected_ids: ['work'], write_calendar_id: null, calendars: [{ id: 'work', label: 'Work calendar with a long readable name', can_write: true }] },
      { id: '00000000-0000-0000-0000-000000000012', provider: 'outlook', mode: 'write', selected_ids: ['personal'], write_calendar_id: null, calendars: [{ id: 'personal', label: 'Personal calendar', can_write: true }] },
    ];
    const tasks = [{ series_id: 3, title: 'Read a chapter and write down three things to remember', titles: ['Read a chapter and write down three things to remember'], starts_on: today,
      rule: { enabled: true, duration_minutes: 30, earliest: 540, latest: 1020, weather: 'any', daylight_only: false, min_temperature_c: 2, max_temperature_c: 30, max_rain_percent: 30, max_wind_kph: 40, buffer_minutes: 0 } }];
    const event = (id, title, start, end, more = {}) => ({ id, title, starts_at: new Date(start * 1000).toISOString(), ends_at: new Date(end * 1000).toISOString(), notes: '', kind: 'event', all_day: false, updated_at: '"v1"', ...more });
    let external = [event('external-demo', 'Read-only work meeting', hour(10), hour(11), { source: 'google', read_only: true, connection_id: connections[0].id, calendar_id: 'work', calendar_label: 'Work calendar', blocks_time: true })];
    await context.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url());
      if (req.method() !== 'GET') writes.push({ path: url.pathname, body: req.postDataJSON() });
      if (url.pathname === '/api/calendar/task-planning' && req.method() === 'GET') return route.fulfill({ json: { tasks } });
      if (url.pathname.startsWith('/api/calendar/task-planning/')) { tasks[0].rule = req.postDataJSON(); return route.fulfill({ json: { rule: tasks[0].rule } }); }
      if (url.pathname === '/api/calendar/connections') return route.fulfill({ json: { connections, providers: [{ id: 'google', label: 'Google Calendar', ready: true }, { id: 'outlook', label: 'Outlook', ready: true }] } });
      if (url.pathname.startsWith('/api/calendar/connect/')) return route.fulfill({ status: 503, json: { detail: 'Demo: authorization was not started' } });
      if (url.pathname.startsWith('/api/calendar/connections/')) { const row = connections.find(c => c.id === url.pathname.split('/').at(-1)); Object.assign(row, req.postDataJSON(), { mode: req.postDataJSON().allow_writes ? 'write' : 'read' }); return route.fulfill({ json: row }); }
      if (url.pathname === '/api/calendar/external-events' && req.method() === 'GET') { await externalWait; return route.fulfill({ json: { events: external, complete, connections, errors: complete ? [] : [{ message: 'Demo failure' }] } }); }
      if (url.pathname === '/api/calendar/external-events' && req.method() === 'POST') { const body = req.postDataJSON(); const saved = { ...body, id: 'external-created', source: 'outlook', read_only: false, calendar_label: 'Personal calendar', updated_at: '"v2"' }; external.push(saved); return route.fulfill({ json: saved }); }
      if (url.pathname === '/api/calendar/events') return route.fulfill({ json: { events: [event('00000000-0000-0000-0000-000000000001', 'Local planning', hour(9), hour(10))] } });
      if (url.pathname === '/api/range') return route.fulfill({ json: { days: { [today]: [{ title: tasks[0].title, series_id: 3, is_completed: false }] } } });
      if (url.pathname === '/api/task_history') return route.fulfill({ json: [] });
      if (url.pathname === '/api/changes') return route.fulfill({ json: { records: '1', definitions: '1' } });
      return route.fulfill({ json: {} });
    });
    await page.goto(base + '/calendar?day=' + today + '&view=day');
    await page.getByRole('button', { name: /Local planning/ }).waitFor();
    assert.equal(await page.locator('.is-suggestion').count(), 0, 'A partial schedule never produces a suggestion');
    releaseExternal();
    await page.locator('.is-suggestion').first().waitFor();
    const first = +(await page.locator('.is-suggestion').first().getAttribute('data-slot'));
    assert(first >= hour(11), 'Indoor task fits after both local and connected events without weather');
    await page.getByRole('button', { name: /Read-only work meeting/ }).click();
    const readonly = page.getByRole('dialog', { name: 'Calendar event · read only' });
    assert(await readonly.getByLabel('Title', { exact: true }).isDisabled());
    assert.equal(await readonly.getByRole('button', { name: 'Save event' }).count(), 0);
    await readonly.getByRole('button', { name: 'Close event' }).click();
    await page.getByRole('button', { name: '＋ Add event' }).click();
    const editor = page.getByRole('dialog', { name: 'New event' });
    await editor.getByLabel('Title', { exact: true }).fill('An explicitly exported event');
    const destination = editor.getByLabel('Calendar', { exact: true });
    await destination.locator('option').nth(1).waitFor({ state: 'attached' });
    assert.equal(await destination.locator('option').count(), 2, 'Read-only calendars never appear as destinations: ' + await editor.locator('select').evaluateAll(nodes => nodes.map(el => el.outerHTML).join(' | ')));
    await destination.selectOption(JSON.stringify([connections[1].id, 'personal']));
    await editor.getByRole('button', { name: 'Save event' }).click(); await editor.waitFor({ state: 'hidden' });
    assert(writes.some(write => write.path === '/api/calendar/external-events' && write.body.connection_id === connections[1].id));
    await page.getByRole('button', { name: 'Calendars', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Connected calendars' });
    await dialog.getByRole('button', { name: '+ Google Calendar', exact: true }).click();
    const toggle = dialog.getByRole('switch', { name: 'Allow edits from Stellar' });
    assert.equal(await toggle.isChecked(), false);
    await dialog.getByText('Suggested: read-only access', { exact: true }).waitFor();
    await toggle.check(); await dialog.getByText(/Two-way sync: Stellar can create/).waitFor();
    await dialog.getByRole('button', { name: 'Continue with Google Calendar' }).click();
    await dialog.getByText('Demo: authorization was not started', { exact: true }).waitFor();
    assert.equal(writes.find(write => write.path === '/api/calendar/connect/google').body.allow_writes, true);
    await page.screenshot({ path: `/private/tmp/stellar-calendar-permissions-${engine}.png` });
    await dialog.getByRole('button', { name: 'Close calendar connections' }).click();
    await page.goto(base + '/tasks');
    const planning = page.locator('#task-planning-settings details').first(); await planning.locator('summary').click();
    await planning.getByLabel('Minutes needed', { exact: true }).fill('45');
    await planning.getByLabel('Weather requirement', { exact: true }).selectOption('dry');
    await planning.getByLabel('Max rain chance %', { exact: true }).fill('20');
    await planning.getByRole('button', { name: 'Save scheduling settings' }).click();
    await planning.getByText('Scheduling settings saved.', { exact: true }).waitFor();
    assert.equal(tasks[0].rule.duration_minutes, 45); assert.equal(tasks[0].rule.max_rain_percent, 20);
    for (const width of mobile ? [320, 390] : [1440]) {
      await page.setViewportSize({ width, height: mobile ? 844 : 1000 });
      await planning.scrollIntoViewIfNeeded();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}px Settings bounds`);
      await page.screenshot({ path: `/private/tmp/stellar-task-planning-${engine}-${width}.png` });
    }
    await page.getByRole('button', { name: 'Manage calendars', exact: true }).click();
    await dialog.getByRole('button', { name: '+ Outlook', exact: true }).waitFor();
    await page.setViewportSize({ width: mobile ? 320 : 1440, height: 400 });
    const close = dialog.getByRole('button', { name: 'Close calendar connections' }); const before = await close.boundingBox();
    await dialog.locator('.cal-settings-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
    const after = await close.boundingBox(); assert(Math.abs(after.y - before.y) < 1 && after.y >= 0 && after.y + after.height <= 400, 'Connection close stays visible');
    await close.click();
    assert.deepEqual(errors, []);
    console.log(`${engine}: explicit OAuth intent, read-only enforcement, external destination, task settings and mobile bounds passed`);
  } finally { await browser.close(); }
}
Promise.allSettled([check('chromium', false), check('webkit', true)]).then(results => {
  for (const result of results) if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
});
