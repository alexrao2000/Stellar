/* Run with the isolated local fixture server and demo records only. The range
   layouts must preserve writes, read-only dates, keyboard date selection,
   responsive resizing, the persistent Pool frame, and the approved views. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
const names = ['Weigh yourself', 'Wake Up', 'Read a chapter and write down three things to remember', 'Run', 'Brush teeth', 'Floss', 'Apply for jobs', 'Write something', 'Take a walk', 'Plan tomorrow', 'Coding practice', 'Stretch', 'Supplements', 'No V', 'Clean the kitchen', 'A task that only started recently', 'AnExtraordinarilyLongUnbrokenTaskNameThatMustRemainReadable', 'A task that no longer runs'];
async function check(engine) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit }[engine]).launch(options);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      const OriginalDate = Date, offset = OriginalDate.parse('2026-11-04T20:00:00Z') - OriginalDate.now();
      window.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [OriginalDate.now() + offset])); }
        static now() { return OriginalDate.now() + offset; }
      };
    });
    let poolReads = 0;
    const days = new Map(), writes = [], errors = [];
    const rows = day => {
      if (!days.has(day)) days.set(day, names.filter((title, i) => !(i === 15 && day < '2026-11-03') && !(i === 17 && day > '2026-11-02')).map((title, i) => ({ id: day + ':' + i, day, list_title: 'Daily', title, is_completed: i % 4 === 2 && day <= '2026-11-04', completed_at: null, weight_lbs: title === names[0] ? 150.4 : null, notes: title === names[1] ? 'Wake-up Time: 7:30 am' : '', optional: i % 5 === 4, deadline_at: day + 'T06:30:00Z' })));
      return days.get(day);
    };
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      let data = [];
      if (route.request().method() !== 'GET') {
        writes.push(url);
        if (url.pathname.endsWith('/report')) {
          const body = route.request().postDataJSON();
          const row = rows(url.pathname.split('/')[3]).find(row => row.title === body.title);
          row.is_completed = body.state === 'done'; row.status = { done: 'completed', incomplete: 'incomplete', unreported: 'unreported' }[body.state]; data = row;
        } else if (url.pathname.endsWith('/toggle')) {
          const id = decodeURIComponent(url.pathname.split('/')[3]);
          const row = [...days.values()].flat().find(row => String(row.id) === id);
          if (row) row.is_completed = url.searchParams.get('done') === 'true';
          data = row || {};
        } else if (url.pathname.includes('/weight')) {
          const row = rows(url.pathname.split('/')[3]).find(row => row.title === names[0]);
          row.weight_lbs = Number(url.searchParams.get('lbs')); row.is_completed = true; data = row;
        } else if (url.pathname.includes('/wake')) {
          const row = rows(url.pathname.split('/')[3]).find(row => row.title === names[1]);
          row.is_completed = true; row.notes = 'Wake-up Time: ' + url.searchParams.get('time') + ' am'; data = row;
        }
      } else if (url.pathname === '/api/range') {
        const result = {};
        for (let day = new Date(url.searchParams.get('start') + 'T12:00:00Z'), end = new Date(url.searchParams.get('end') + 'T12:00:00Z'); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
          const key = day.toISOString().slice(0, 10); result[key] = rows(key);
        }
        data = { days: result, today: '2026-11-04', floor: '2026-08-01' };
      } else if (url.pathname.startsWith('/api/day/')) data = rows(url.pathname.split('/')[3]);
      else if (url.pathname === '/api/pool') { poolReads++; data = { tasks: [{ id: '1', title: 'Demo star', x: .6, y: .4, status: 'open' }], edges: [] }; }
      await route.fulfill({ contentType: 'application/json', headers: { 'X-Day-Complete': '1' }, body: JSON.stringify(data) });
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    const assets = []; page.on('request', request => { if (request.url().includes('/app-assets/ranges.')) assets.push(request.url()); });
    await page.goto(base + '/?day=2026-11-04');
    await page.locator('#tasks .task').first().waitFor();
    await page.waitForFunction(() => !document.documentElement.classList.contains('app-booting'));
    assert.equal(assets.length, 0, 'Day does not frontload the other range renderer');
    const toggleTop = (await page.locator('.sidebar-collapse').boundingBox()).y;
    const linkTop = (await page.getByRole('link', { name: 'Space', exact: true }).boundingBox()).y;
    await page.getByRole('button', { name: 'Collapse sidebar' }).click(); await page.waitForTimeout(400);
    assert.equal((await page.locator('.sidebar-collapse').boundingBox()).y, toggleTop);
    assert.equal((await page.getByRole('link', { name: 'Space', exact: true }).boundingBox()).y, linkTop);
    await page.getByRole('button', { name: 'Expand sidebar' }).click(); await page.waitForTimeout(400);
    const originalHeight = (await page.locator('.dated-tasks').boundingBox()).height;
    const pool = page.frames().find(frame => frame.url().includes('/pool?embedded=true'));
    await pool.locator('#sky[data-loading=false]').waitFor();
    const poolIdentity = await pool.evaluate(() => window.rangeTestIdentity = Math.random());
    let unavailable = true;
    await context.route('**/app-assets/ranges.js?*', route => unavailable ? route.abort() : route.fallback());
    await page.locator('[data-view="3days"]').click();
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    unavailable = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.range-table').waitFor();
    for (const view of ['3days', 'week', 'custom']) {
      await page.locator(`[data-view="${view}"]`).click();
      await page.locator('.range-table').waitFor();
      const panel = await page.locator('.dated-tasks').boundingBox();
      assert.equal(panel.height, originalHeight, 'Panel height stays consistent across ranges');
      assert.equal(await pool.evaluate(() => window.rangeTestIdentity), poolIdentity, 'Range changes preserve the Pool');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.equal(await page.locator('.range-table .range-task-name').allTextContents().then(names => new Set(names).size), await page.locator('.range-table .range-task-name').count());
      if (view === 'week') assert.equal(await page.locator('.range-table thead .range-date').count(), 7);
      const future = page.locator('.range-table thead .range-date[data-day="2026-11-05"]');
      if (await future.count()) {
        const index = await future.evaluate(button => button.closest('th').cellIndex + 1);
        assert.equal(await page.locator(`.range-table tbody td:nth-child(${index}) button:not(:disabled)`).count(), 0);
      }
    }
    await page.locator('[data-view=day]').click(); await page.waitForTimeout(450);
    const startWidth = (await page.locator('.dated-tasks').boundingBox()).width, beforeAnimationReads = poolReads;
    await page.locator('[data-view=week]').click();
    const widths = await page.locator('.dated-tasks').evaluate(async panel => {
      const values = [];
      for (let i = 0; i < 25; i++) { await new Promise(requestAnimationFrame); values.push(panel.getBoundingClientRect().width); }
      return values;
    });
    const endWidth = widths.at(-1);
    assert(widths.some(width => width > Math.min(startWidth, endWidth) + 1 && width < Math.max(startWidth, endWidth) - 1), 'Range widths interpolate');
    assert(poolReads - beforeAnimationReads <= 1, 'Animation does not repeatedly refresh Pool records');
    await page.locator('.range-table').waitFor();
    const run = page.getByRole('button', { name: 'Run, Nov 4, Incomplete', exact: true });
    await run.click();
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('button', { name: 'Run, Nov 4, Done', exact: true }).getAttribute('aria-pressed'), 'true');
    assert(writes.some(url => url.pathname.endsWith('/report')));
    const weight = page.getByRole('button', { name: /Weight, Wednesday, Nov 4, 150.4/ });
    assert.equal(await weight.getAttribute('data-completed'), 'false', 'Existing readings do not imply completion');
    await weight.click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('spinbutton').fill('151.7');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: /Weight, Wednesday, Nov 4, 151.7/ }).waitFor();
    assert(writes.some(url => url.pathname.endsWith('/weight') && url.searchParams.get('lbs') === '151.7'));
    assert.equal(await page.getByRole('button', { name: /Weight, Wednesday, Nov 4, 151.7/ }).getAttribute('data-completed'), 'true', 'Saved completion updates the reading indicator');
    await page.getByRole('button', { name: /Weight, Wednesday, Nov 4, 151.7/ }).click();
    await dialog.getByRole('spinbutton').fill('199');
    const beforeCancel = writes.length; await page.keyboard.press('Escape'); await page.waitForTimeout(100);
    assert.equal(writes.length, beforeCancel, 'Escape cancels unsaved edits');
    await page.getByRole('button', { name: /Wake up, Wednesday, Nov 4/ }).click();
    await dialog.locator('input[type=time]').fill('08:15');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('button', { name: /Wake up, Wednesday, Nov 4, 08:15/ }).waitFor();
    assert(writes.some(url => url.pathname.endsWith('/wake') && url.searchParams.get('time') === '08:15'));
    await page.locator('[data-view=custom]').click();
    await page.locator('#range-start').fill('2026-10-01'); await page.locator('#range-start').dispatchEvent('change');
    await page.locator('#range-end').fill('2026-11-12'); await page.locator('#range-end').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelectorAll('.range-table thead .range-date').length > 30);
    const scroll = page.locator('.range-scroll');
    assert(await scroll.evaluate(node => node.scrollWidth > node.clientWidth));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await scroll.evaluate(node => { node.scrollLeft = node.scrollWidth; node.scrollTop = 300; });
    const sticky = await page.locator('.range-task-name').first().boundingBox(), scrollBox = await scroll.boundingBox();
    assert(Math.abs(sticky.x - scrollBox.x) < 3, 'Task names stay visible while scrolling across dates');
    await page.screenshot({ path: `/private/tmp/range-custom-${engine}-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.range-focus').waitFor();
    assert.equal(await page.locator('.range-table').count(), 0, 'Phones build only the selected day');
    for (const view of ['3days', 'week', 'custom']) {
      await page.locator(`[data-view="${view}"]`).click();
      await page.locator('.range-dates [aria-pressed=true]').waitFor();
      const selected = page.locator('.range-dates [aria-pressed=true]');
      await selected.focus(); await page.keyboard.press('ArrowLeft');
      assert((await page.url()).includes('focus='));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const fields = page.locator('.range-focus input');
      for (const input of await fields.all()) assert((await input.boundingBox()).height >= 44);
      await page.screenshot({ path: `/private/tmp/range-${view}-${engine}-mobile.png` });
    }
    for (const width of [320, 360, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      for (const input of await page.locator('.range-focus .mini.field input').all()) {
        const dimensions = await input.evaluate(input => {
          const row = input.closest('.mini.field'), box = row.querySelector('.mbox');
          const card = row.getBoundingClientRect(), field = input.getBoundingClientRect(), icon = box.getBoundingClientRect();
          const hit = getComputedStyle(box, '::before');
          return { left: field.left - card.left, right: card.right - field.right,
            bottom: card.bottom - field.bottom, iconWidth: icon.width, iconHeight: icon.height,
            hitWidth: parseFloat(hit.width), hitHeight: parseFloat(hit.height), height: field.height };
        });
        assert(dimensions.left >= 10 && dimensions.right >= 10 && dimensions.bottom >= 8, `${engine} ${width}: measurement stays inside its card`);
        assert.equal(dimensions.iconHeight, dimensions.iconWidth, `${engine} ${width}: status icon stays square`);
        assert(dimensions.hitWidth >= 44 && dimensions.hitHeight >= 44 && dimensions.height >= 44, 'Controls keep usable touch targets');
      }
      if (width === 320 || width === 390) await page.screenshot({ path: `/private/tmp/stellar-measurements-${engine}-${width}-after.png` });
    }
    await page.setViewportSize({ width: 1440, height: 900 }); await page.locator('.range-table').waitFor();
    await page.locator('[data-view=day]').click(); await page.locator('#day-card').waitFor();
    assert.equal(await page.locator('.dated-tasks').boundingBox().then(box => box.height), originalHeight);
    await page.locator('[data-view=month]').click(); await page.locator('#board > .month').waitFor();
    assert.equal(await page.locator('.dated-tasks').boundingBox().then(box => box.height), originalHeight);
    for (const day of ['2027-02-15', '2026-11-15', '2026-12-15']) {
      await page.goto(base + '/?view=month&day=' + day); await page.locator('#board > .month').waitFor();
      const gap = await page.evaluate(() => document.getElementById('board').getBoundingClientRect().bottom - document.querySelector('.month').getBoundingClientRect().bottom);
      assert(gap < 5, 'Months with four, five, or six weeks fill the available panel');
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-view=day]').click(); await page.waitForTimeout(30);
    assert.equal(await page.locator('.dated-tasks').evaluate(panel => panel.getAnimations().filter(animation => animation.playState === 'running').length), 0);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(base + '/?view=week&day=2026-07-15'); await page.locator('.range-table').waitFor();
    assert.equal(await page.locator('.range-table tbody button:not(:disabled)').count(), 0, 'Dates before the write floor remain locked');
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme });
      for (const width of [320, 760, 820, 1100, 1280, 1920]) {
        await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(80);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${colorScheme} ${width}: no horizontal page clipping`);
      }
    }
    assert.deepEqual(errors, []);
    console.log(`${engine}: range writes, cancellation, read-only dates, keyboard selection, sticky custom ranges, resizing, themes, panel height and Pool retention passed`);
  } finally { await browser.close(); }
}
(async () => { for (const engine of ['chromium', 'webkit']) await check(engine); })().catch(error => { console.error(error); process.exit(1); });
