/* Verify the keyboard and touch affordances against an isolated mock backend. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
const day = 86400000;
const now = Date.parse('2026-11-25T20:00:00Z');

async function check(engine) {
  const executablePath = engine === 'chromium' ? process.env.CHROMIUM_EXECUTABLE : undefined;
  const browser = await ({ chromium, webkit })[engine].launch({ executablePath });
  try {
    const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    const identity = page.locator('body');
    const tasks = [
      { id: 1, title: 'New supernova', x: .48, y: .44, created_at: new Date(now - day * 89).toISOString() },
      { id: 2, title: 'Big black hole', x: .77, y: .69, created_at: new Date(now - day * 130).toISOString() },
    ];
    const errors = [], undoRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: now });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/pool') return route.fulfill({ json: { tasks, edges: [] } });
      if (url.pathname.startsWith('/api/day/')) return route.fulfill({ json: [], headers: { 'X-Day-Complete': '1' } });
      const match = url.pathname.match(/^\/api\/pool\/task\/(\d+)\/resolve$/);
      if (!match) return route.fulfill({ json: {} });
      const task = tasks.find(task => task.id === Number(match[1]));
      const expected = url.searchParams.get('expected_resolved_at');
      const at = await page.evaluate(() => Date.now());
      if (expected && task.resolved_at !== expected) return route.fulfill({ status: 409, json: { detail: 'Resolution changed' } });
      if (url.searchParams.get('done') === 'true') {
        task.resolved_at = new Date(at).toISOString();
      } else {
        if (expected) undoRequests.push(task.id);
        task.age_started_at = new Date(Date.parse(task.age_started_at || task.created_at) + at - Date.parse(task.resolved_at)).toISOString();
        task.resolved_at = null;
      }
      return route.fulfill({ json: task });
    });
    await page.goto(base + '/pool');
    const star = id => page.locator('#pool-map .star[data-id="' + id + '"]');
    const undo = page.getByRole('button', { name: 'Undo resolve' });
    const resolve = async id => {
      await star(id).locator('.hit').click();
      await page.getByRole('button', { name: 'Resolve', exact: true }).click();
      await star(id).waitFor({ state: 'detached' });
      await undo.waitFor();
    };
    await resolve(1);
    await resolve(2);
    await page.clock.fastForward(4 * day);
    await page.getByRole('button', { name: 'Show resolved' }).click();
    await star(1).locator('.hit').click();
    assert.match(await page.locator('#panel .pmeta').innerText(), /89 days old/);
    await page.locator('#pnotes').fill('Draft');
    await page.keyboard.press('Control+z');
    assert.equal(undoRequests.length, 0, 'Typing keeps the field’s native undo');
    await page.locator('#pnotes').fill('');
    await page.locator('#pclose').click();

    await page.keyboard.press('Meta+z');
    await star(2).locator('.pool-vortex').waitFor({ state: 'attached' });
    await star(2).locator('.hit').click();
    assert.match(await page.locator('#panel .pmeta').innerText(), /130 days open/);
    await page.locator('#pclose').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Map', exact: true }).click();
    assert((await undo.boundingBox()).height >= 44, 'Undo has a full-size touch target');
    await page.screenshot({ path: '/private/tmp/stellar-star-undo-' + engine + '.png' });
    await undo.click();
    await star(1).locator('.stellar-shockwave').first().waitFor({ state: 'attached' });
    await undo.waitFor({ state: 'hidden' });
    assert.deepEqual(undoRequests, [2, 1]);
    assert(!tasks[0].resolved_at && !tasks[1].resolved_at);
    await page.clock.fastForward(day + 1000);
    await star(1).locator('.pool-vortex').waitFor({ state: 'attached' });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base + '/?view=day');
    await identity.waitFor();
    const embedded = page.frameLocator('#pool-frame');
    const embeddedStar = embedded.locator('.star[data-id="1"]');
    await embeddedStar.locator('.hit').waitFor();
    await embeddedStar.evaluate(el => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await embedded.getByRole('button', { name: 'Resolve', exact: true }).click();
    await embedded.getByRole('button', { name: 'Undo resolve' }).waitFor();
    await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
    await embeddedStar.locator('.pool-vortex').waitFor({ state: 'attached' });
    assert.deepEqual(undoRequests, [2, 1, 1]);
    assert.deepEqual(errors, []);
    console.log(engine + ': paused ages, keyboard and touch undo, input protection and embedded shortcut passed');
  } finally { await browser.close(); }
}

Promise.allSettled(['chromium', 'webkit'].map(check)).then(results => {
  for (const result of results) if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
});
