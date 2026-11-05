/* Two independent sessions share only a mock backend. Verify remote changes,
   draft protection, conditional checks, cached sections, and Month progress. */
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    const desktop = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
    const phone = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, hasTouch: true });
    const versions = { records: 0, definitions: 0, pool: 0 }, calls = [], errors = [];
    const day = '2026-11-04';
    const rows = d => [
      { id: 1, title: 'Weigh yourself', weight_lbs: 150.4, is_completed: true },
      { id: 2, title: 'Wake Up', notes: 'Wake-up Time: 7:30 am', is_completed: true },
      { id: 3, title: 'Remote task', is_completed: done },
      { id: 4, title: 'Optional task', optional: true, is_completed: false }
    ].map(row => ({ day: d, list_title: 'Daily', optional: false, status: row.is_completed ? 'completed' : 'needsAction', deadline_at: d + 'T06:00:00Z', ...row }));
    let done = false, notes = 'Original description', resolved = false, failChecks = false, activeChecks = 0, maxChecks = 0, staleReads = 0;
    const routeFor = context => context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      calls.push({ context: context === desktop ? 'desktop' : 'phone', path: url.pathname, search: url.search, method: request.method() });
      let data;
      if (url.pathname === '/api/changes') {
        activeChecks++; maxChecks = Math.max(maxChecks, activeChecks);
        await new Promise(resolve => setTimeout(resolve, 60)); activeChecks--;
        if (failChecks) return route.fulfill({ status: 503, body: '{}' });
        const etag = '"' + Object.values(versions).join(':') + '"';
        if (request.headers()['if-none-match'] === etag) return route.fulfill({ status: 304, headers: { ETag: etag } });
        return route.fulfill({ contentType: 'application/json', headers: { ETag: etag }, body: JSON.stringify(versions) });
      }
      if (url.pathname.endsWith('/report')) { done = request.postDataJSON().state === 'done'; versions.records++; data = rows(day)[2]; }
      else if (url.pathname.startsWith('/api/day/')) data = rows(url.pathname.split('/')[3]);
      else if (url.pathname === '/api/range') {
        const days = {};
        for (let date = new Date(url.searchParams.get('start') + 'T12:00:00Z'), end = new Date(url.searchParams.get('end') + 'T12:00:00Z'); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
          const d = date.toISOString().slice(0, 10); days[d] = rows(d);
        }
        data = { days };
      } else if (url.pathname === '/api/pool') data = { tasks: [{ id: '1', title: 'Shared star', x: .6, y: .4, status: resolved ? 'resolved' : 'open', resolved_at: resolved ? day + 'T12:00:00Z' : null, notes }], edges: [] };
      else if (url.pathname === '/api/task_history') { if (!url.searchParams.has('fresh')) staleReads++; data = rows(day); }
      else if (url.pathname === '/api/metrics') data = { revision: String(versions.records), modules: [{ id: 'overview', label: 'Overview', kind: 'overview' }, { id: 'task-remote', label: 'Remote task', kind: 'task', titles: ['Remote task'] }] };
      else if (url.pathname === '/api/consistency') data = rows(day);
      else if (url.pathname === '/api/task_settings') {
        data = await (await route.fetch()).json();
        if (versions.definitions) data.tasks.find(task => !task.measurement && !task.stopped && !task.binned).title = 'Renamed on phone';
      } else return route.fallback();
      await route.fulfill({ contentType: 'application/json', headers: { 'X-Day-Complete': '1' }, body: JSON.stringify(data) });
    });
    await routeFor(desktop); await routeFor(phone);
    const page = await desktop.newPage(), mobile = await phone.newPage();
    page.on('pageerror', error => errors.push(error.message)); mobile.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/?day=' + day); await mobile.goto(base + '/?day=' + day);
    const readyFrame = async path => {
      await page.waitForFunction(path => [...document.querySelectorAll('iframe.stellar-section')].some(frame => {
        try { return frame.contentWindow.location.pathname === path && frame.contentDocument.readyState === 'complete'; } catch { return false; }
      }), path);
      return page.frames().find(frame => frame !== page.mainFrame() && new URL(frame.url()).pathname === path);
    };
    const tick = async () => { await page.evaluate(() => StellarSync.check()); await page.waitForTimeout(250); };
    await tick(); await page.waitForFunction(() => StellarSync.managed);
    const task = page.locator('#tasks .task').filter({ hasText: 'Remote task' });
    await task.waitFor(); assert.equal(await task.evaluate(el => el.classList.contains('done')), false);
    await page.locator('#weight').focus();
    await mobile.locator('#tasks .task').filter({ hasText: 'Remote task' }).click();
    await mobile.waitForFunction(() => !document.querySelector('#tasks .task[data-syncing]'));
    await tick(); await page.waitForFunction(() => [...document.querySelectorAll('#tasks .task')].find(n => n.textContent.includes('Remote task')).classList.contains('done'));
    const dataReads = () => calls.filter(call => call.context === 'desktop' && ['/api/day/' + day, '/api/pool', '/api/metrics', '/api/task_history'].includes(call.path)).length;
    await page.waitForTimeout(500); const before = dataReads();
    await tick(); await tick(); assert.equal(dataReads(), before, 'Unchanged revisions do not download task data');
    await page.locator('#weight').fill('199');
    done = false; versions.records++; await tick();
    assert.equal(await page.locator('#weight').inputValue(), '199', 'Remote refresh preserves an actual draft');
    assert.equal(await task.evaluate(el => el.classList.contains('done')), true, 'Busy view leaves revision pending');
    await page.locator('#weight').fill('150.4'); await page.locator('#weight').blur();
    await page.waitForFunction(() => [...document.querySelectorAll('#tasks .task')].find(n => n.textContent.includes('Remote task')).classList.contains('done') === false);
    const pool = page.frames().find(frame => frame.url().includes('/pool?embedded=true'));
    await pool.locator('.star[data-id="1"] .hit').click(); await pool.locator('#pnotes').focus();
    notes = 'Changed on phone'; versions.pool++; await tick();
    await pool.waitForFunction(() => document.querySelector('#pnotes')?.value === 'Changed on phone');
    assert.equal(await pool.locator('#pnotes').evaluate(el => el === document.activeElement), true, 'Clean focus survives remote refresh');
    await pool.locator('#pnotes').fill('Unsaved draft'); notes = 'Another remote change'; versions.pool++; await tick();
    assert.equal(await pool.locator('#pnotes').inputValue(), 'Unsaved draft');
    await pool.locator('#pnotes').fill('Changed on phone'); await pool.locator('#pclose').click(); await tick();
    await pool.locator('.star[data-id="1"] .hit').click();
    assert.equal(await pool.locator('#pnotes').inputValue(), 'Another remote change');
    resolved = true; versions.pool++; await tick(); await pool.waitForFunction(() => !document.querySelector('.star[data-id="1"]'));
    assert.equal(await pool.locator('#pnotes').count(), 0, 'Remote resolution closes the clean panel');
    await page.getByRole('link', { name: 'Activity', exact: true }).click();
    const activity = await readyFrame('/data');
    await activity.locator('#rows .pill').first().waitFor(); await tick();
    done = true; versions.records++; await tick();
    await activity.waitForFunction(() => [...document.querySelectorAll('#rows tr')].some(row => row.textContent.includes('Remote task') && row.textContent.includes('Done')));
    assert.equal(staleReads, 0, 'Activity explicitly bypasses worker history caches');
    await page.getByRole('link', { name: 'Metrics', exact: true }).click();
    const metrics = await readyFrame('/metrics');
    await metrics.locator('#metric-panel[aria-busy=false]').waitFor(); await tick();
    await metrics.locator('#metric-task-toggle').click();
    await metrics.getByRole('button', { name: 'Remote task', exact: true }).click();
    await metrics.frameLocator('#metric-frame').locator('#pct').waitFor();
    done = false; versions.records++; await tick();
    await metrics.waitForFunction(() => document.querySelector('#metric-frame')?.contentDocument?.querySelector('#pct')?.textContent === '0.0%');
    assert(await metrics.frameLocator('#metric-frame').locator('#pct').isVisible());
    assert(calls.some(call => call.path === '/api/metrics' && call.search.includes('fresh=true')));
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    const settings = await readyFrame('/tasks');
    await settings.locator('#live .title').first().waitFor(); await tick();
    await settings.locator('#new-title').fill('New task draft');
    const settingTitle = settings.locator('#live .title').first(), originalTitle = await settingTitle.inputValue();
    await settingTitle.fill('Unsaved rename'); versions.definitions++; await tick();
    assert.equal(await settingTitle.inputValue(), 'Unsaved rename');
    await settingTitle.fill(originalTitle); await settingTitle.blur();
    await settings.waitForFunction(() => [...document.querySelectorAll('#live .title')].some(el => el.value === 'Renamed on phone'));
    assert.equal(await settings.locator('#new-title').inputValue(), 'New task draft', 'Settings refresh preserves the add form');
    await page.getByRole('link', { name: 'Space', exact: true }).click(); await tick();
    await page.locator('[data-view=month]').click(); await page.locator('#board .range-progress').waitFor();
    assert.equal(await page.locator('#board .summary').count(), 0);
    assert((await page.locator('#board .range-percent').innerText()).includes('%'));
    await page.screenshot({ path: '/private/tmp/stellar-month-progress.png' });
    failChecks = true; await tick(); assert(await page.locator('#board .range-progress').isVisible());
    failChecks = false;
    await page.evaluate(() => { for (let i = 0; i < 12; i++) StellarSync.check(); }); await page.waitForTimeout(500);
    assert(maxChecks <= 2, 'Each browser keeps revision checks single-flight');
    assert.deepEqual(errors, []);
    console.log('Independent phone/desktop sync, conditional checks, cached Activity, clean focus, draft protection, Month progress: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
