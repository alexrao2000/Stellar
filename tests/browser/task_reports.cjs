/* Demo-only end-to-end checks for optional bonuses, explicit report states,
   report clearing, mobile long press, measurement retention, and frequency.
   All API traffic is intercepted; no production records are read or written. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
async function check(engine, mobile) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit }[engine]).launch(options);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, hasTouch: mobile });
    const records = new Map(), writes = [], errors = [];
    let revision = 0, fail = false;
    const rows = day => {
      if (!records.has(day)) records.set(day, Array.from({ length: 9 }, (_, i) => ({ id: day + ':' + i, day, title: i === 0 ? 'Weigh yourself' : i === 1 ? 'Wake Up' : i === 8 ? 'Bonus' : 'Required ' + i, list_title: 'Daily', optional: i === 8, is_completed: i < 8, status: i < 8 ? 'completed' : 'needsAction', report_due_at: day + 'T07:00:00Z', deadline_at: day + 'T07:00:00Z', completed_at: i < 8 ? day + 'T06:00:00Z' : null, weight_lbs: i === 0 ? 150.4 : null, notes: i === 1 ? 'Wake-up Time: 7:30 am' : 'Keep this note' })));
      return records.get(day);
    };
    const day = '2026-11-04';
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url()); let data = [];
      if (url.pathname.endsWith('/report')) {
        writes.push(route.request().postDataJSON());
        if (fail) { fail = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"Demo save failure"}' }); }
        const body = writes.at(-1), row = rows(url.pathname.split('/')[3]).find(row => row.title === body.title);
        row.is_completed = body.state === 'done'; row.status = row.is_completed ? 'completed' : body.state; row.completed_at = row.is_completed ? day + 'T06:00:00Z' : null;
        revision++; data = { ...row };
      } else if (url.pathname.startsWith('/api/day/')) data = rows(url.pathname.split('/')[3]);
      else if (url.pathname === '/api/range') {
        const days = {};
        for (let date = new Date(url.searchParams.get('start') + 'T12:00:00Z'), end = new Date(url.searchParams.get('end') + 'T12:00:00Z'); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
          const key = date.toISOString().slice(0, 10); days[key] = rows(key);
        }
        data = { days };
      } else if (url.pathname === '/api/pool') data = { tasks: [], edges: [] };
      else if (url.pathname === '/api/task_history') data = rows(day);
      else if (url.pathname === '/api/metrics') data = { revision: String(revision), modules: [{ id: 'overview', label: 'Overview', kind: 'overview' }, { id: 'task-bonus', label: 'Bonus', kind: 'task', titles: ['Bonus'] }] };
      else if (url.pathname === '/api/consistency') {
        const statuses = ['completed', 'completed', 'incomplete', 'incomplete', 'unknown', 'needsAction', 'needsAction'];
        data = statuses.map((status, i) => ({ ...rows(day)[8], day: '2026-10-' + (20 + i), is_completed: status === 'completed', status }));
      }
      await route.fulfill({ contentType: 'application/json', headers: { 'X-Day-Complete': '1' }, body: JSON.stringify(data) });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/?day=' + day);
    await page.locator('#day-completion strong').waitFor();
    assert.equal(await page.locator('#day-completion strong').innerText(), '8/8');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const visibleDust = await page.locator('#tasks .task.done .report-ember').evaluateAll(nodes => {
      nodes.forEach(node => node.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 1400; }));
      const visible = nodes.some(node => node.getBoundingClientRect().width >= 2 && Number(getComputedStyle(node).opacity) >= .5);
      nodes.forEach(node => node.getAnimations().forEach(animation => animation.play()));
      return visible;
    });
    assert(visibleDust, 'Completed tasks emit visible stardust at native icon size');

    const bonus = page.locator('#tasks .task').filter({ hasText: 'Bonus' });
    assert(await bonus.evaluate(node => node.classList.contains('unreported')));
    await bonus.click(); await page.waitForFunction(() => !document.querySelector('#tasks .task[data-syncing]'));
    assert.equal(await page.locator('#day-completion strong').innerText(), '9/8');
    await page.locator('#tasks .task').filter({ hasText: 'Required 2' }).click();
    await page.waitForFunction(() => !document.querySelector('#tasks .task[data-syncing]'));
    assert.equal(await page.locator('#day-completion strong').innerText(), '8/8');
    assert((await page.locator('#day-completion').innerText()).includes('7/8 required'));
    assert((await page.locator('#day-completion').getAttribute('title')).includes('1 required task remaining'));
    await bonus.click(); await page.waitForFunction(() => !document.querySelector('#tasks .task[data-syncing]'));
    assert.equal(writes.at(-1).state, 'incomplete');
    assert(!(await bonus.innerText()).toLowerCase().includes('missed'));
    const open = async locator => {
      if (mobile) {
        const before = writes.length;
        await locator.scrollIntoViewIfNeeded(); await page.waitForTimeout(150);
        const box = await locator.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
        await locator.dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 42, clientX: x, clientY: y });
        await page.waitForTimeout(600);
        await locator.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 42, clientX: x, clientY: y });
        assert.equal(writes.length, before, 'Long press does not toggle');
      } else await locator.click({ button: 'right' });
      await page.locator('.report-picker').waitFor();
      assert(await page.locator('.report-picker').evaluate(node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; }));
    };
    await open(bonus);
    await page.locator('.report-option[data-state=unreported]').click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#tasks .task')).some(node => node.textContent.includes('Bonus') && node.classList.contains('unreported')));
    assert.equal(writes.at(-1).state, 'unreported');
    assert(await bonus.evaluate(node => node.classList.contains('unreported')));
    const beforeDismiss = writes.length;
    await open(bonus); await page.keyboard.press('Escape'); assert.equal(writes.length, beforeDismiss);
    const weightStatus = page.locator('#field-weight button.box');
    assert(await page.locator('#field-weight [data-measurement-complete]').isVisible(), 'Recorded completion has a visible Done badge');
    await open(weightStatus); await page.locator('.report-option[data-state=unknown]').click();
    await page.locator('#field-weight button.box[data-report-icon=unknown]:enabled').waitFor();
    assert.equal(writes.at(-1).state, 'unknown');
    assert.equal(await page.locator('#day-completion strong').innerText(), '6/8', 'Unknown does not complete a required task');
    assert.equal(await page.locator('#weight').inputValue(), '150.4', 'Reporting uncertainty preserves the recorded measurement');
    assert.equal(rows(day)[0].weight_lbs, 150.4);
    assert(!(await page.locator('#field-weight [data-measurement-complete]').isVisible()), 'A retained value does not imply completion');
    await page.reload(); await bonus.waitFor();
    assert(await bonus.evaluate(node => node.classList.contains('unreported')), 'Unreported survives reload');
    await page.locator('#field-weight button.box[data-report-icon=unknown]').waitFor();
    fail = true;
    await bonus.click(); await page.getByText('Demo save failure', { exact: true }).waitFor();
    assert(await bonus.evaluate(node => node.classList.contains('unreported')), 'Failed writes restore the prior report');
    Object.assign(rows(day)[3], { is_completed: false, status: 'needsAction', report_due_at: '2070-01-01T07:00:00Z' });
    await page.reload();
    const pending = page.locator('#tasks .task').filter({ hasText: 'Required 3' });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('#tasks .task')).some(node => node.textContent.includes('Required 3') && node.classList.contains('unreported')));
    fail = true; await pending.click(); await page.getByText('Demo save failure', { exact: true }).waitFor();
    assert.equal(await pending.evaluate(node => node.closest('.item')._row.status), 'needsAction', 'Failed writes preserve automatic-deadline defaults');
    await page.locator('[data-view=week]').click();
    if (mobile) {
      await page.locator('.range-focus').waitFor();
      await page.locator('.range-dates [data-day="2026-11-04"]').click();
    } else await page.locator('.range-table').waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: `/private/tmp/task-reports-${engine}-${mobile ? 'phone' : 'desktop'}.png` });
    await page.goto(base + '/metrics?tab=task-bonus');
    await page.locator('#metric-panel[aria-busy=false]').waitFor();
    const chart = page.frameLocator('#metric-frame');
    assert.equal(await chart.locator('#pct').innerText(), '2.0/week');
    const cells = chart.locator('#tstrip .cell');
    for (const [label, value] of [['Done', '2'], ['Incomplete', '2'], ['Unreported', '2'], ["Don't Know", '1']]) {
      const cell = cells.filter({ has: chart.getByText(label, { exact: true }) });
      assert.equal(await cell.locator('.v').innerText(), value);
    }
    assert.equal(await chart.locator('.heatgrid [data-day="2026-10-24"].unknown').count(), 1);
    assert(!(await chart.locator('#detail-card').innerText()).includes('%'), 'Optional metrics use frequency');
    assert(!(await chart.locator('#detail-card').innerText()).includes('Missed'));
    await page.goto(base + '/data'); await page.locator('#rows tr').first().waitFor();
    await page.locator('#status').selectOption('unreported');
    assert((await page.locator('#rows').innerText()).includes('Bonus'));
    assert((await page.locator('#rows').innerText()).includes('Unreported'));
    await page.locator('#status').selectOption('incomplete');
    assert((await page.locator('#rows').innerText()).includes('Required 2'));
    await page.locator('#status').selectOption('unknown');
    assert((await page.locator('#rows').innerText()).includes("Don't Know"));
    assert.equal(await page.locator('#rows .pill.unknown').count(), 1);
    assert.deepEqual(errors, []);
    console.log(`${engine} ${mobile ? 'phone' : 'desktop'}: bonus goals, toggling, clearing, failed saves, measurement retention, frequency and Activity states passed`);
  } finally { await browser.close(); }
}
(async () => { for (const engine of ['chromium', 'webkit']) for (const mobile of [false, true]) await check(engine, mobile); })().catch(error => { console.error(error); process.exit(1); });
