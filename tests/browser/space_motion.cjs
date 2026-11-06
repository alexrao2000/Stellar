/* Synthetic records only. Idle Space must settle, the sky bitmap must survive
   range changes, and hidden sections must stop their decorative work. Gold dust
   stays softly visible at native size and travels beyond its gray status icon. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';

async function check(engine) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit }[engine]).launch(options);
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
    await context.addInitScript(() => {
      window.motionWork = { frames: 0, copies: 0, skyResets: 0 };
      const raf = window.requestAnimationFrame;
      window.requestAnimationFrame = callback => {
        if (callback.name === 'tickDust') window.motionWork.frames++;
        return raf(callback);
      };
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (...args) {
        if (this.canvas.id === 'dust') window.motionWork.copies++;
        return draw.apply(this, args);
      };
      const width = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width');
      Object.defineProperty(HTMLCanvasElement.prototype, 'width', { ...width, set(value) {
        if (this.id === 'dust-base') window.motionWork.skyResets++;
        width.set.call(this, value);
      } });
    });
    const rows = day => Array.from({ length: 20 }, (_, i) => ({ id: day + ':' + i, day, title: 'Demo task ' + i,
      list_title: 'Daily', optional: i > 15, is_completed: i < 15, status: i < 15 ? 'completed' : 'needsAction', report_due_at: day + 'T07:00:00Z' }));
    await context.route('**/api/**', async route => {
      const url = new URL(route.request().url()); let data = [];
      if (url.pathname === '/api/changes') data = { records: '1', definitions: '1', pool: '1' };
      else if (url.pathname.startsWith('/api/day/')) data = rows(url.pathname.split('/')[3]);
      else if (url.pathname === '/api/range') {
        const days = {};
        for (let date = new Date(url.searchParams.get('start') + 'T12:00:00Z'), end = new Date(url.searchParams.get('end') + 'T12:00:00Z'); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
          const day = date.toISOString().slice(0, 10); days[day] = rows(day);
        }
        data = { days };
      } else if (url.pathname === '/api/pool') data = { tasks: Array.from({ length: 25 }, (_, i) => ({ id: String(i), title: 'Demo star ' + i,
        x: .1 + i % 5 * .17, y: .1 + Math.floor(i / 5) * .17, resolved_at: null })), edges: [] };
      await route.fulfill({ contentType: 'application/json', headers: { 'X-Day-Complete': '1' }, body: JSON.stringify(data) });
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base + '/?day=2026-11-04');
    await page.frameLocator('#pool-frame').locator('.star .hit').first().waitFor();
    await page.locator('#tasks .task.done').first().waitFor();
    await page.waitForTimeout(1800);
    const pool = page.frames().find(frame => frame.url().includes('embedded=true'));
    const before = await pool.evaluate(() => ({ ...window.motionWork }));
    const labelWrites = await page.locator('#pool-toggle').evaluate(async toggle => {
      let writes = 0;
      const observer = new MutationObserver(records => { writes += records.length; });
      observer.observe(toggle, { childList: true, subtree: true, characterData: true });
      await new Promise(resolve => setTimeout(resolve, 650));
      observer.disconnect(); return writes;
    });
    const after = await pool.evaluate(() => ({ ...window.motionWork }));
    assert.equal(labelWrites, 0, 'Idle layout must not rewrite its own observed toggle');
    assert(after.frames - before.frames <= 12, 'Dust must not wake JavaScript on every display frame');
    assert.equal(after.copies, 0, 'Static sky is never copied into each animated frame');
    await page.locator('[data-view=month]').click(); await page.locator('.month').waitFor(); await page.waitForTimeout(450);
    assert.equal(await pool.evaluate(() => window.motionWork.skyResets), after.skyResets, 'Range width animation preserves the unchanged sky bitmap');
    await page.locator('[data-view=day]').click(); await page.waitForTimeout(450);
    await page.evaluate(() => window.stellarSetActive(false));
    assert.equal(await pool.locator('#sky').getAttribute('data-motion-paused'), 'true');
    const paused = await pool.evaluate(() => window.motionWork.frames);
    await page.waitForTimeout(300);
    assert.equal(await pool.evaluate(() => window.motionWork.frames), paused, 'Inactive Space stops its dust scheduler');
    assert(await page.locator('.report-ember').first().evaluate(node => node.getAnimations().every(animation => animation.playState === 'paused')));
    await page.evaluate(() => window.stellarSetActive(true));
    await page.setViewportSize({ width: 390, height: 844 });
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'no-preference' });
      const icon = page.locator('#tasks .task.done .stellar-status').first();
      const dust = await icon.evaluate(host => {
        const gray = getComputedStyle(host).color.match(/[\d.]+/g).map(Number);
        const grain = host.querySelector('.report-dust-core'), particle = grain.parentElement;
        const animation = particle.getAnimations()[0], timing = animation.effect.getTiming(); animation.pause();
        const point = progress => {
          animation.currentTime = Number(timing.delay) + Number(timing.duration) * (1 + progress);
          const rect = particle.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, opacity: Number(getComputedStyle(particle).opacity) };
        };
        const near = point(.15), far = point(.75);
        return { gray, background: getComputedStyle(grain).backgroundImage, filter: getComputedStyle(particle).filter,
          distance: Math.hypot(far.x - near.x, far.y - near.y), near };
      });
      assert.equal(dust.gray[0], dust.gray[1]); assert.equal(dust.gray[1], dust.gray[2]);
      assert(dust.background.includes('238, 230, 214'), 'Glint has a pale champagne tint');
      assert.equal(dust.filter, 'none', 'Glows use cached artwork instead of animated SVG filters');
      assert(dust.near.width >= 4 && dust.near.width <= 10 && dust.near.opacity > 0 && dust.near.opacity <= .7, 'Shimmer stays small and soft at native phone size');
      assert(dust.distance > 20, 'Gold dust travels well beyond its icon');
      await icon.evaluate(host => host.querySelectorAll('.report-ember').forEach(node => node.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 2000; })));
      const rect = await icon.boundingBox();
      await page.screenshot({ path: `/private/tmp/stellar-gold-${engine}-${theme}.png`, clip: { x: Math.max(0, rect.x - 35), y: Math.max(0, rect.y - 38), width: rect.width + 85, height: rect.height + 80 } });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await icon.locator('.report-ember').first().evaluate(node => getComputedStyle(node).display), 'none');
    }
    assert.deepEqual(errors, []);
    console.log(engine + ': idle layout, bounded sky work, preserved bitmap, hidden pause, gold glow/drift and reduced motion passed');
  } finally { await browser.close(); }
}
(async () => { for (const engine of ['chromium', 'webkit']) await check(engine); })().catch(error => { console.error(error); process.exit(1); });
