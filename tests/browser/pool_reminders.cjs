/* Run against a local Stellar server (AUTH_ENABLED=false, VERCEL=1).
   All records and Push APIs are replaced with demo fixtures. Permission prompts
   and device actions are checked without sending actual OS notifications. */
const assert = require('node:assert/strict');
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.STELLAR_TEST_URL || 'http://127.0.0.1:8000';
(async () => {
  for (const engine of ['chromium', 'webkit']) {
    const options = { headless: true };
    if (engine === 'chromium' && process.env.CHROMIUM_EXECUTABLE) options.executablePath = process.env.CHROMIUM_EXECUTABLE;
    const browser = await ({ chromium, webkit }[engine]).launch(options);
    try {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
      await context.addInitScript(() => {
        window.permissionRequests = 0;
        const Notification = { permission: 'default', requestPermission: async () => { window.permissionRequests++; Notification.permission = 'granted'; return 'granted'; } };
        Object.defineProperty(window, 'Notification', { value: Notification, configurable: true });
        Object.defineProperty(window, 'PushManager', { value: function () {}, configurable: true });
        let subscribed = false;
        const subscription = { endpoint: 'https://fcm.googleapis.com/demo-device', toJSON() { return { endpoint: this.endpoint, keys: { auth: 'demo', p256dh: 'demo' } }; }, unsubscribe: async () => { subscribed = false; return true; } };
        const registration = { pushManager: { getSubscription: async () => subscribed ? subscription : null, subscribe: async () => { subscribed = true; return subscription; } } };
        Object.defineProperty(navigator, 'serviceWorker', { value: { register: async () => registration, ready: Promise.resolve(registration) }, configurable: true });
      });
      const state = { tasks: [{ id: 1, title: 'Demo reminder star', notes: '', x: .4, y: .4, resolved_at: null,
        remind_at: new Date(Date.now() + 86400000).toISOString(), reminder_version: 'one', reminder_sent_at: null }], edges: [] };
      const requests = [];
      await context.route('**/api/**', async route => {
        const request = route.request(), url = new URL(request.url());
        let data;
        if (url.pathname === '/api/pool') data = state;
        else if (url.pathname === '/api/notifications/config') data = { enabled: true, public_key: 'BA', default_hours: 24 };
        else if (url.pathname.startsWith('/api/notifications/')) {
          requests.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() }); data = { ok: true, id: 'device' };
        } else if (url.pathname.endsWith('/reminder')) {
          const body = request.postDataJSON(); requests.push({ path: url.pathname, body });
          Object.assign(state.tasks[0], { remind_at: body.at, reminder_sent_at: null, reminder_version: 'two' }); data = state.tasks[0];
        } else throw Error('Unexpected API call: ' + url.pathname);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      });
      const page = await context.newPage();
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/pool?star=1');
      await page.locator('#pool-reminder-form').waitFor();
      await page.getByRole('button', { name: 'Enable notifications', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.permissionRequests), 0, 'Opening a star must not prompt');
      await page.getByRole('button', { name: 'Enable notifications', exact: true }).click();
      await page.getByRole('button', { name: 'Send test', exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.permissionRequests), 1);
      await page.getByRole('button', { name: 'Send test', exact: true }).click();
      await page.getByText('Test sent. Check your device notifications.').waitFor();
      assert(requests.some(request => request.path === '/api/notifications/test'));
      await page.locator('#pool-reminder-clear').click();
      await page.getByText('No reminder set', { exact: true }).waitFor();
      assert.equal(state.tasks[0].remind_at, null);
      await page.locator('#pool-reminder-tomorrow').click();
      await page.waitForFunction(() => document.querySelector('#pool-reminder-time').value !== '');
      assert(Math.abs(Date.parse(state.tasks[0].remind_at) - Date.now() - 86400000) < 10000);
      await page.getByRole('button', { name: 'Turn off', exact: true }).waitFor();
      const input = page.locator('#pool-reminder-time');
      await input.fill('2020-01-01T12:00');
      const count = requests.length;
      await page.getByRole('button', { name: 'Save time', exact: true }).click();
      await page.getByText('Choose a future reminder time.', { exact: true }).waitFor();
      assert.equal(requests.length, count);
      await page.getByRole('button', { name: 'Turn off', exact: true }).click();
      await page.getByRole('button', { name: 'Enable notifications', exact: true }).waitFor();
      assert(requests.some(request => request.method === 'DELETE'));
      for (const [width, height] of [[320,568], [390,844], [667,375]]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(80);
        const bounds = await page.locator('#panel').boundingBox();
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        assert(bounds.y >= 0 && bounds.y + bounds.height <= height + 1);
        await page.locator('#pool-reminder-tomorrow').scrollIntoViewIfNeeded();
        await page.locator('#pool-reminder-tomorrow').click();
        await page.waitForTimeout(80);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      assert.deepEqual(errors, []);
      console.log(engine + ': deep links, explicit permission, device test/disable, reminder changes and compact layouts passed');
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
