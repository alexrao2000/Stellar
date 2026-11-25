/* Populated demo pages verify the shared palette inside retained metric frames,
   readable API details, fixed-size choices, keyboard focus and narrow layouts.
   All app data is intercepted; no production records are read or written. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
const longName = 'Read a chapter and write down three things to remember';
const records = Array.from({ length: 120 }, (_, i) => ({
  id: i + 1, day: new Date(Date.UTC(2026, 10, 24 - Math.floor(i / 3))).toISOString().slice(0, 10),
  title: ['Run', longName, 'Take a walk'][i % 3], list_title: 'Daily',
  is_completed: i % 4 !== 0, status: i % 4 ? 'completed' : 'incomplete', optional: i % 3 === 2,
  notes: i % 7 === 0 ? 'Notes from a demo record' : '',
}));
async function check(engine, mobile) {
  const browser = await ({ chromium, webkit })[engine].launch(engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
  try {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      serviceWorkers: 'block', colorScheme: 'light', isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), errors = [], mutations = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => {
      const D = Date, offset = D.parse('2026-11-24T20:00:00Z') - D.now();
      window.Date = class extends D {
        constructor(...args) { super(...(args.length ? args : [D.now() + offset])); }
        static now() { return D.now() + offset; }
      };
    });
    await context.route('**/api/**', route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() !== 'GET') mutations.push(url.pathname);
      let data = [];
      if (url.pathname === '/api/metrics') data = { revision: '1', modules: [
        { id: 'overview', label: 'Overview', kind: 'overview' }, { id: 'weight', label: 'Weight', kind: 'weight' },
        { id: 'wake', label: 'Wake', kind: 'wake' }, { id: 'task-demo', label: longName, kind: 'task', titles: [longName] },
      ] };
      else if (['/api/task_history', '/api/consistency'].includes(url.pathname)) data = records;
      else if (['/api/weights', '/api/wake'].includes(url.pathname)) data = Array.from({ length: 24 }, (_, i) => ({
        d: new Date(Date.UTC(2026, 10, i + 1)).toISOString().slice(0, 10), w: url.pathname === '/api/weights' ? 150 + Math.sin(i / 5) * 3 : 7 + Math.sin(i / 5) * .5,
      }));
      else if (url.pathname === '/api/changes') data = { records: '1', definitions: '1', pool: '1' };
      return route.fulfill({ json: data });
    });
    const fits = async () => {
      const geometry = await page.evaluate(() => ({
        width: innerWidth, scroll: document.documentElement.scrollWidth,
        overflow: [...document.querySelectorAll('body *')].filter(node => {
          const r = node.getBoundingClientRect(); return r.width && r.right > innerWidth + 1;
        }).slice(0, 10).map(node => ({ tag: node.tagName, class: node.className })),
      }));
      assert(geometry.scroll <= geometry.width + 1, 'Only intended charts/tables may scroll sideways: ' + JSON.stringify(geometry));
    };
    const readable = async locator => {
      const values = await locator.evaluate(node => {
        const style = getComputedStyle(node);
        return { color: style.color, scheme: style.colorScheme };
      });
      const rgb = values.color.match(/[\d.]+/g).slice(0, 3).map(Number);
      assert(rgb.every(value => value > 150), 'Themed text must stay light and readable even with a light OS preference');
    };
    await page.goto(base + '/metrics?tab=weight');
    await page.locator('#metric-panel[aria-busy=false]').waitFor();
    await readable(page.locator('.metrics-wrap > h1'));
    const weight = page.frames().find(frame => frame.url().includes('/weight?'));
    await readable(weight.locator('.readout .val').first());
    assert(await weight.locator('canvas#chart').evaluate(canvas => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let light = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 150 && pixels[i + 1] > 150 && pixels[i + 2] > 150 && pixels[i + 3] > 128) light++;
      return light > 50;
    }), 'Canvas labels and series remain readable on the dark chart panel');
    for (const label of ['Wake', 'Overview']) {
      await page.getByRole('tab', { name: label, exact: true }).click();
      await page.locator('#metric-panel[aria-busy=false]').waitFor(); await fits();
    }
    await page.locator('#metric-task-toggle').click();
    await page.getByRole('searchbox', { name: 'Find a task', exact: true }).fill('Read');
    const option = page.locator('#metric-task-options button').first(); await page.keyboard.press('ArrowDown');
    assert(await option.evaluate(node => node === document.activeElement), 'Task picker supports keyboard progression');
    assert.notEqual(await option.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    await option.click(); await page.locator('#metric-panel[aria-busy=false]').waitFor();
    if (mobile) { await page.setViewportSize({ width: 320, height: 844 }); await fits(); await page.setViewportSize({ width: 390, height: 844 }); }
    await page.screenshot({ path: `/private/tmp/stellar-themed-metrics-${engine}-${mobile ? 'mobile' : 'desktop'}.png` });
    await page.goto(base + '/data'); await page.locator('tbody tr').first().waitFor();
    await readable(page.locator('.wrap > h1')); await fits();
    await page.getByRole('searchbox', { name: 'Filter', exact: true }).fill('Read');
    assert((await page.locator('#count').textContent()).includes('40'));
    if (mobile) await page.getByRole('button', { name: 'Show details', exact: true }).first().click();
    if (mobile) { await page.setViewportSize({ width: 320, height: 844 }); await fits(); await page.setViewportSize({ width: 390, height: 844 }); }
    await page.screenshot({ path: `/private/tmp/stellar-themed-activity-${engine}-${mobile ? 'mobile' : 'desktop'}.png` });
    await page.goto(base + '/tasks'); await page.locator('#new-title').waitFor();
    await readable(page.locator('.wrap > h1'));
    assert(await page.locator('.opt:checked').count() > 0);
    assert(await page.locator('.opt:not(:checked)').count() > 0);
    await page.locator('#live details:has(.title) > summary').first().click();
    for (const width of mobile ? [320, 390] : [1440]) {
      await page.setViewportSize({ width, height: mobile ? 844 : 1000 }); await fits();
      for (const input of await page.locator('.wrap input:not([type=checkbox]), .wrap textarea.title').all()) {
        if (!await input.isVisible()) continue;
        assert(await input.evaluate(node => {
          const row = node.closest('.row,.bar,.add'), a = row.getBoundingClientRect(), b = node.getBoundingClientRect();
          return b.left >= a.left - 1 && b.right <= a.right + 1 && b.height >= 39;
        }), 'Settings controls stay inside their rows and retain a consistent target height');
      }
      const choices = await page.locator('.wrap input[type=checkbox]').evaluateAll(nodes => nodes.map(node => {
        const r = node.getBoundingClientRect(); return [r.width, r.height];
      }));
      assert(choices.filter(([w]) => w > 0).every(([w, h]) => w === h && w >= 16), 'Choice indicators retain fixed square dimensions');
    }
    await page.screenshot({ path: `/private/tmp/stellar-themed-settings-${engine}-${mobile ? 'mobile' : 'desktop'}.png` });
    await page.goto(base + '/docs'); await page.locator('#swagger-ui .opblock').first().waitFor();
    await readable(page.locator('.swagger-ui .info .title')); await fits();
    const endpoint = page.locator('.opblock').filter({ hasText: '/api/pool/task/{task_id}/reminder' }).first();
    await endpoint.locator('.opblock-summary').click();
    await endpoint.locator('.opblock-body').waitFor(); await fits();
    await readable(endpoint.locator('.parameters-col_name').first());
    if (mobile) { await page.setViewportSize({ width: 320, height: 844 }); await fits(); await page.setViewportSize({ width: 390, height: 844 }); }
    await page.screenshot({ path: `/private/tmp/stellar-themed-api-${engine}-${mobile ? 'mobile' : 'desktop'}.png` });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.space-backdrop').evaluate(node => getComputedStyle(node, '::before').animationName), 'none');
    assert.deepEqual(mutations, []); assert.deepEqual(errors, []);
    console.log(`${engine} ${mobile ? 'mobile' : 'desktop'}: themed metrics/frames, Activity, Settings, API, focus and bounds passed`);
    await context.close();
  } finally { await browser.close(); }
}
(async () => { for (const engine of ['chromium', 'webkit']) for (const mobile of [false, true]) await check(engine, mobile); })()
  .catch(error => { console.error(error); process.exitCode = 1; });
