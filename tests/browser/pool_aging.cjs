/* Check age transitions with synthetic tasks in the standalone Pool. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
const day = 86400000;
const now = Date.parse('2026-11-25T20:00:00Z');
const created = daysAgo => new Date(now - daysAgo * day).toISOString();

async function check(engine) {
  const executablePath = engine === 'chromium' ? process.env.CHROMIUM_EXECUTABLE : undefined;
  const browser = await ({ chromium, webkit })[engine].launch({ executablePath });
  try {
    const mobile = engine === 'webkit';
    const page = await browser.newPage({ serviceWorkers: 'block', viewport: { width: mobile ? 390 : 1360, height: 840 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.install({ time: now });
    await page.route('**/api/**', route => {
      if (new URL(route.request().url()).pathname !== '/api/pool') return route.fulfill({ json: {} });
      return route.fulfill({ json: {
        tasks: [
          { id: 1, title: 'Start the outline', x: .18, y: .56, created_at: created(2) },
          { id: 2, title: 'Finish the draft', x: .82, y: .56, created_at: created(5) },
          { id: 3, title: 'Revisit the archive', x: .55, y: .52, created_at: created(195) },
          { id: 4, title: 'Try a different sketch', x: .48, y: .29, created_at: created(90 - 60000 / day) },
          { id: 5, title: 'Old completed task', x: .7, y: .7, created_at: created(220), resolved_at: created(1) },
          { id: 6, title: 'Plan the next chapter', x: .23, y: .78, created_at: created(125) },
          { id: 7, title: 'Red star', x: .73, y: .35, created_at: created(71) },
        ],
        edges: [{ before_id: 1, after_id: 2 }],
      } });
    });
    await page.goto(base + '/pool');
    if (mobile) {
      const list = page.getByRole('list', { name: 'Constellation tasks' });
      await list.getByRole('button', { name: /Revisit the archive.*195 days open/ }).waitFor();
      assert.match(await list.locator('li').first().innerText(), /Revisit the archive/);
      assert.match(await list.locator('li').nth(1).innerText(), /Plan the next chapter/);
      await page.getByRole('button', { name: 'Map', exact: true }).click();
    }
    const older = page.getByRole('button', { name: 'Revisit the archive, black hole' });
    await older.locator('.hit').waitFor();
    const shadows = page.locator('#lines circle');
    const biggest = Math.max(...await shadows.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('r')))));
    assert.match(await page.locator('#lines > path').getAttribute('d'), /Q/, 'A link bends in the old black hole’s vicinity');
    await page.locator('.star[data-id="1"][data-stage="protostar"]').waitFor({ state: 'attached' });
    await page.locator('.star[data-id="2"][data-stage="main"]').waitFor({ state: 'attached' });
    await page.locator('.star[data-id="7"][data-stage="supergiant"]').waitFor({ state: 'attached' });
    const newborn = page.locator('.star[data-id="4"]');
    const supernova = newborn.locator('.stellar-shockwave');
    assert.equal(await supernova.count(), 2);
    const supernovaSize = Number(await newborn.locator('svg').getAttribute('width'));
    const labelBefore = await newborn.locator('.name').boundingBox();
    const crossDeadline = async () => {
      const wait = now + 60060 - await page.evaluate(() => Date.now());
      await page.clock.fastForward(wait);
    };
    await crossDeadline();
    await newborn.locator('.pool-vortex').waitFor({ state: 'attached' });
    await newborn.locator('.pool-collapse-core').waitFor({ state: 'attached' });
    assert.deepEqual(await newborn.locator('.name').boundingBox(), labelBefore, 'The star label stays in place during collapse');
    assert.equal(await older.locator('.pool-collapse').count(), 0, 'Previously collapsed stars do not replay the effect');
    const started = await newborn.getAttribute('data-collapse-started');
    const width = element => element.evaluate(el => el.offsetWidth);
    const firstVortex = await width(newborn.locator('.pool-vortex'));
    assert(firstVortex > supernovaSize && firstVortex < supernovaSize * 1.2, 'A newborn black hole starts slightly larger than the supernova');
    assert(await width(older.locator('.pool-vortex')) > firstVortex + 20, 'The visible vortex grows with age');
    const smallest = Math.min(...await shadows.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('r')))));
    assert(biggest > smallest * 2, 'Older black holes have a larger effect');
    await page.getByRole('button', { name: 'Show resolved', exact: true }).click();
    assert.equal(await newborn.getAttribute('data-collapse-started'), started, 'A map redraw preserves the collapse timeline');
    await newborn.locator('.pool-vortex').evaluate(el => {
      el.getAnimations().find(animation => animation.animationName === 'collapse-vortex').finish();
    });
    await newborn.locator('.pool-collapse').waitFor({ state: 'detached' });
    await page.locator('.star[data-id="5"].ember').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.star[data-id="5"].black-hole').count(), 0);
    const art = older.locator('.pool-vortex');
    const motion = await art.evaluate(el => {
      const ribbon = el.querySelector('.accretion-flow'), mote = el.querySelector('.vortex-mote');
      const sample = (node, progress) => {
        const animation = node.getAnimations()[0], timing = animation.effect.getTiming();
        animation.pause();
        const cycle = Math.ceil(-timing.delay / timing.duration) + 1;
        animation.currentTime = timing.delay + timing.duration * (cycle + progress);
        return new DOMMatrix(getComputedStyle(node).transform);
      };
      const first = sample(ribbon, .1), second = sample(ribbon, .3);
      const near = sample(mote, .72), far = sample(mote, .22);
      return { turn: Math.abs(first.b - second.b), inward: Math.hypot(far.e, far.f) - Math.hypot(near.e, near.f) };
    });
    assert(motion.turn > .25 && motion.inward > 12, 'Ribbons rotate visibly and the dust moves toward the core');
    await page.screenshot({ path: `/private/tmp/stellar-pool-vortex-${engine}.png` });
    await page.evaluate(() => window.stellarSetActive(false));
    assert.equal(await art.locator('.vortex-filaments').evaluate(el => getComputedStyle(el).animationPlayState), 'paused');
    await page.evaluate(() => window.stellarSetActive(true));
    await older.locator('.hit').click();
    assert.match(await page.locator('#panel .pmeta').innerText(), /195 days open/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await older.locator('.accretion-flow').evaluate(el => getComputedStyle(el).animationName), 'none');
    assert.equal(await art.locator('.vortex-mote').first().evaluate(el => getComputedStyle(el).animationName), 'none');
    await page.clock.setSystemTime(now + 53000);
    await page.reload();
    await newborn.locator('.stellar-shockwave').first().waitFor({ state: 'attached' });
    await crossDeadline();
    assert.equal(await newborn.locator('.pool-vortex').count(), 1);
    assert.equal(await newborn.locator('.pool-collapse').count(), 0, 'Reduced motion skips the collapse effect');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.clock.setSystemTime(now + 53000);
    await page.reload();
    await newborn.locator('.stellar-shockwave').first().waitFor({ state: 'attached' });
    await page.evaluate(() => window.stellarSetActive(false));
    await crossDeadline();
    await page.evaluate(() => window.stellarSetActive(true));
    assert.equal(await newborn.locator('.pool-vortex').count(), 1);
    assert.equal(await newborn.locator('.pool-collapse').count(), 0, 'A hidden map does not play the effect when it returns');
    await page.reload();
    await newborn.locator('.pool-vortex').waitFor({ state: 'attached' });
    assert.equal(await newborn.locator('.pool-collapse').count(), 0, 'Opening an already collapsed star skips the effect');
    assert.deepEqual(errors, []);
    console.log(`${engine}: one-shot collapse, visibility, reduced motion, widening shadow and curved links passed`);
  } finally { await browser.close(); }
}

Promise.allSettled(['chromium', 'webkit'].map(check)).then(results => {
  for (const result of results) if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
});
