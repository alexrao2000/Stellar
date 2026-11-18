/* Compare rendered frames around each precipitation loop boundary. Keep the
   cloud image still so a passing result cannot hide a precipitation reset.
   A row-energy check catches horizontal bands even when the loop is seamless. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';

async function pixelDelta(page, shots) {
  return page.evaluate(async shots => {
    const images = await Promise.all(shots.map(src => new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.src = 'data:image/png;base64,' + src;
    })));
    const canvas = document.createElement('canvas');
    canvas.width = images[0].width; canvas.height = images[0].height;
    const ctx = canvas.getContext('2d');
    const pixels = images.map(image => {
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    });
    let delta = 0;
    for (let i = 0; i < pixels[0].length; i += 4) {
      for (let channel = 0; channel < 3; channel++) delta += Math.abs(pixels[0][i + channel] - pixels[1][i + channel]);
    }
    return delta / (canvas.width * canvas.height * 3);
  }, shots);
}

async function check(engine) {
  const options = { headless: true };
  if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
  const browser = await ({ chromium, webkit })[engine].launch(options);
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 600 }, deviceScaleFactor: 3, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.route('**/api/**', route => route.fulfill({ json: {} }));
    await page.goto(base + '/space-shell', { waitUntil: 'domcontentloaded' });
    await page.setContent(`<link rel="stylesheet" href="/app-assets/weather.css">
      <style>body { margin: 0; } .weather-scene { opacity: 1; transition: none; }</style>
      <div class="weather-scene" data-scene="rain" data-phase="day"
        style="--weather-image: url('/app-assets/weather-storm.jpg')"></div>`);
    await page.waitForFunction(() => document.getAnimations().some(a => a.animationName === 'weather-rain'));
    await page.evaluate(async () => {
      const image = new Image(); image.src = '/app-assets/weather-storm.jpg'; await image.decode();
    });
    for (const kind of ['rain', 'storm', 'snow']) {
      await page.locator('.weather-scene').evaluate((el, kind) => {
        el.dataset.scene = kind;
        el.replaceChildren();
        if (kind !== 'snow') {
          const far = document.createElement('div'); far.className = 'weather-rain-depth'; el.append(far);
        }
      }, kind);
      const shots = [];
      for (const fraction of [0, .999999, .5]) {
        await page.locator('.weather-scene').evaluate((el, fraction) => {
          for (const animation of el.getAnimations({ subtree: true })) {
            animation.pause();
            animation.currentTime = /weather-(rain|snow)/.test(animation.animationName)
              ? animation.effect.getTiming().duration * fraction : 0;
          }
        }, fraction);
        shots.push((await page.screenshot()).toString('base64'));
      }
      const seam = await pixelDelta(page, shots.slice(0, 2));
      const motion = await pixelDelta(page, [shots[0], shots[2]]);
      assert(seam < .005, `${engine} ${kind}: loop boundary should be visually continuous, delta=${seam}`);
      assert(motion > .02, `${engine} ${kind}: precipitation must visibly move, delta=${motion}`);
      console.log(`${engine} ${kind}: loop delta ${seam.toFixed(5)}, moving frame delta ${motion.toFixed(3)}`);
    }
    await page.locator('.weather-scene').evaluate(el => { el.dataset.scene = 'rain'; });
    await page.addStyleTag({ content: '.weather-scene { background: #000; } .weather-scene::before { visibility: hidden; }' });
    await page.locator('.weather-scene').evaluate(el => {
      for (const a of el.getAnimations({ subtree: true })) { a.pause(); a.currentTime = 0; }
    });
    const rain = (await page.screenshot()).toString('base64');
    const bands = await page.evaluate(async src => {
      const image = new Image(); image.src = 'data:image/png;base64,' + src; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const rows = Array.from({ length: canvas.height }, (_, y) => {
        let sum = 0;
        for (let x = 0; x < canvas.width; x++) sum += pixels[(y * canvas.width + x) * 4];
        return sum;
      }).sort((a, b) => b - a);
      return rows.slice(0, Math.ceil(rows.length / 5)).reduce((a, b) => a + b, 0) / rows.reduce((a, b) => a + b, 0);
    }, rain);
    assert(bands < .55, `${engine}: rain should be scattered across the scene, brightest 20% of rows carry ${bands} of its light`);
    console.log(`${engine}: brightest 20% of rain rows carry ${(bands * 100).toFixed(1)}% of its light`);
    await page.locator('.weather-scene').evaluate(el => { el.dataset.scene = 'cloud'; });
    const before = await page.locator('.weather-scene').evaluate(el => {
      const animation = el.getAnimations({ subtree: true }).find(a => a.animationName === 'weather-drift');
      animation.pause(); animation.currentTime = 15000;
      const style = getComputedStyle(el, '::before');
      return { filter: style.filter, scale: new DOMMatrix(style.transform).a };
    });
    assert.equal(before.filter, 'none', 'The moving bitmap needs no filter render pass');
    assert.equal(before.scale, 1, 'The cloud texture keeps its raster size throughout the animation');
  } finally { await browser.close(); }
}

Promise.allSettled([check('chromium'), check('webkit')]).then(results => {
  for (const result of results) {
    if (result.status === 'rejected') { console.error(result.reason); process.exitCode = 1; }
  }
});
