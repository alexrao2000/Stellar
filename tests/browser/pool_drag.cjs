/* Run against a local Stellar server with AUTH_ENABLED=false and VERCEL=1.
   Install playwright separately; PLAYWRIGHT_MODULE can select its module path.
   All API traffic is replaced with demo data. Delayed writes and stale reads
   exercise position persistence, including redraws while a star is held. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';

async function check(engine) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit }[engine]).launch(options);
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const state = { tasks: [{ id: 1, title: 'Demo star', x: .3, y: .4, resolved_at: null }], edges: [] };
    const original = JSON.stringify(state);
    let stale = false, hold = false, finish, writes = 0, fail = false;
    await context.addInitScript(() => {
      const interval = window.setInterval;
      window.setInterval = (fn, ms, ...args) => {
        if (ms === 15000) { window.refreshPool = fn; return 0; }
        return interval(fn, ms, ...args);
      };
    });
    await context.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      assert(url.pathname.startsWith('/api/pool'));
      if (request.method() === 'GET') {
        return route.fulfill({ contentType: 'application/json', body: stale ? original : JSON.stringify(state) });
      }
      if (url.pathname === '/api/pool/task') {
        const task = { id: 2, title: 'Added during drag', x: .7, y: .7, resolved_at: null };
        state.tasks.push(task);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(task) });
      }
      assert(url.pathname.endsWith('/move'));
      writes++;
      if (hold) { hold = false; await new Promise(resolve => { finish = resolve; }); }
      if (fail) {
        fail = false;
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"Temporary failure"}' });
      }
      state.tasks[0].x = Number(url.searchParams.get('x'));
      state.tasks[0].y = Number(url.searchParams.get('y'));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.tasks[0]) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/pool');
    await page.locator('.star[data-id="1"] .hit').waitFor();
    await page.waitForTimeout(300);
    const star = page.locator('.star[data-id="1"]');
    const point = () => star.evaluate(el => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
    const near = async expected => {
      const actual = await point();
      assert(Math.abs(actual.x - expected.x) < .2 && Math.abs(actual.y - expected.y) < .2, JSON.stringify({ actual, expected }));
    };
    const drag = async (dx, dy, release = true) => {
      const box = await star.locator('.hit').boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 8 });
      if (release) await page.mouse.up();
      await page.waitForTimeout(80);
    };
    const refresh = async () => {
      await page.evaluate(() => window.refreshPool());
      await page.waitForTimeout(100);
    };
    await drag(100, 70);
    const dropped = await point();
    stale = true;
    await refresh();
    await near(dropped);
    stale = false;
    await refresh();
    await page.reload();
    await star.locator('.hit').waitFor();
    await page.waitForTimeout(300);
    await near(dropped);

    hold = true; fail = true;
    await drag(40, 30);
    assert(finish, 'First write should be pending');
    const before = writes;
    await drag(50, -50);
    const latest = await point();
    assert.equal(writes, before, 'Second write must wait for the first');
    finish();
    await page.waitForTimeout(200);
    assert.equal(writes, before + 1);
    await near(latest);
    await refresh();
    await near(latest);

    await drag(20, 20, false);
    await page.setViewportSize({ width: 1380, height: 920 });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.held').count(), 1, 'Resize must retain the held star');
    await page.mouse.up();
    await page.waitForTimeout(100);
    await refresh();

    hold = true; fail = true;
    await drag(-30, 20);
    const unsaved = await point();
    finish();
    await page.waitForTimeout(100);
    await near(unsaved);
    assert.equal(await page.locator('#note').textContent(), 'Position not saved. Retrying…');
    await refresh();
    await refresh();
    await near(unsaved);
    assert.equal(await page.locator('#note').textContent(), '');

    await drag(30, -20, false);
    await page.evaluate(async () => {
      const input = document.querySelector('#add');
      input.value = 'Added during drag';
      document.querySelector('#pool-add').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 80));
    });
    assert.equal(await page.locator('.held').count(), 1, 'A completed add must not cancel a held star');
    await page.mouse.up();
    await page.locator('.star[data-id="2"] .hit').waitFor();
    assert.equal(await page.locator('.held').count(), 0);
    assert.deepEqual(errors, []);
    console.log(engine + ': stale reads, ordered writes, failed-save retry, resize and add during drag passed');
  } finally { await browser.close(); }
}
(async () => { for (const engine of ['chromium', 'webkit']) await check(engine); })().catch(error => { console.error(error); process.exitCode = 1; });
