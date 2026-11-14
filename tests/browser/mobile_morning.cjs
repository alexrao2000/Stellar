/* A suspended or freshly opened phone must show cached tasks during a slow
   refresh. Wake edits are drafts until submitted. All records here are fake. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
const firstDay = '2026-11-13', secondDay = '2026-11-14';
const rows = day => [
  { id: day + ':wake', day, title: 'Wake Up', list_title: 'Daily', status: 'needsAction', is_completed: false, notes: '' },
  { id: day + ':run', day, title: 'Run', list_title: 'Daily', status: 'needsAction', is_completed: false },
];

async function check(engine) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit }[engine]).launch(options);
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block',
    });
    const page = await context.newPage();
    const records = new Map([[firstDay, rows(firstDay)], [secondDay, rows(secondDay)]]);
    const writes = [], documents = [];
    let releaseDay;
    const holdDay = new Promise(resolve => { releaseDay = resolve; });
    let blockReads = true;
    await page.addInitScript(({ day, rows }) => localStorage.setItem('td:' + day, JSON.stringify(rows)), { day: firstDay, rows: rows(firstDay) });
    await page.clock.install({ time: new Date('2026-11-13T15:36:00Z') });
    page.on('request', request => { if (request.resourceType() === 'document') documents.push(request.url()); });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const day = url.pathname.split('/')[3];
      let data = {};
      if (url.pathname.endsWith('/wake')) {
        writes.push([day, url.searchParams.get('time')]);
        const row = records.get(day)[0];
        Object.assign(row, { status: 'completed', is_completed: true, notes: 'Wake-up Time: 8:20 am', completed_at: day + 'T16:00:00Z' });
        data = row;
      } else if (records.has(day)) {
        if (blockReads) await holdDay;
        data = records.get(day);
      } else if (url.pathname === '/api/range') {
        data = { days: Object.fromEntries([...records].filter(([day]) => day >= url.searchParams.get('start') && day <= url.searchParams.get('end'))) };
      }
      await route.fulfill({ json: data });
    });

    await page.goto(base + '/?day=' + firstDay, { waitUntil: 'domcontentloaded' });
    const run = page.getByRole('button', { name: 'Run', exact: true });
    await run.waitFor({ timeout: 2000 }); // The blocked request cannot make this pass.
    const wake = page.locator('#wake');
    const dialog = page.getByRole('dialog', { name: 'Wake-up time' });
    const time = dialog.locator('input');
    await page.locator('#field-wake button.box').tap();
    await dialog.waitFor();
    const timezone = await page.locator('#bootstrap').evaluate(node => JSON.parse(node.textContent).tz);
    const expectedTime = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date('2026-11-13T15:36:00Z'));
    assert.equal(await time.inputValue(), expectedTime);
    await time.fill('08:20');
    assert.deepEqual(writes, []);
    await dialog.getByRole('button', { name: 'Cancel' }).tap();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(writes, []);
    assert.equal(await wake.inputValue(), '');

    const initialRead = page.waitForResponse(response => response.url().includes('/api/day/' + firstDay));
    blockReads = false;
    releaseDay();
    await initialRead;
    await wake.tap();
    await time.fill('08:20');
    await dialog.getByRole('button', { name: 'Save' }).tap();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(writes, [[firstDay, '08:20']]);
    assert.equal(await wake.inputValue(), '08:20');
    assert(await page.locator('#field-wake .measurement-complete').isVisible());

    await page.evaluate(({ day, rows }) => {
      localStorage.setItem('td:' + day, JSON.stringify(rows));
      window.morningMarker = true;
    }, { day: secondDay, rows: rows(secondDay) });
    let releaseRollover;
    const holdRollover = new Promise(resolve => { releaseRollover = resolve; });
    await page.route('**/api/day/' + secondDay + '?*', async route => {
      await holdRollover;
      await route.fulfill({ json: records.get(secondDay) });
    });
    await page.clock.setSystemTime(new Date('2026-11-14T15:36:00Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    assert.equal(await page.locator('#pick').inputValue(), secondDay);
    await run.waitFor({ timeout: 2000 });
    assert.equal(await wake.inputValue(), '');
    assert.equal(documents.length, 1);
    assert(await page.evaluate(() => window.morningMarker));
    releaseRollover();
    console.log(engine + ': cached launch, rollover without navigation, Wake draft, cancel and save passed');
  } finally { await browser.close(); }
}

(async () => { for (const engine of ['chromium', 'webkit']) await check(engine); })().catch(error => { console.error(error); process.exitCode = 1; });
