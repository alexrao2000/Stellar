/* Permission is requested only from an explicit click. Device subscriptions are
   kept on the server; opening a star never triggers a permission prompt. */
(() => {
  let configuration;
  const config = () => configuration || (configuration = fetch('/api/notifications/config', { priority: 'low' })
    .then(async response => { if (!response.ok) throw Error('Could not check notification setup.'); return response.json(); })
    .catch(error => { configuration = null; throw error; }));
  const api = async (path, method, body) => {
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(result.detail || 'Could not update notifications.');
    return result;
  };
  const registration = async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(Error('Notifications are taking too long to start. Please retry.')), 10000))]);
  };
  const publicKey = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
  async function mount(root) {
    if (!root || root.dataset.mounted) return;
    root.dataset.mounted = 'true';
    const status = document.createElement('p');
    status.setAttribute('role', 'status'); status.textContent = 'Checking notifications…';
    const actions = document.createElement('div'); actions.className = 'notification-actions';
    root.replaceChildren(status, actions);
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone ||
      (parent !== window && parent.matchMedia('(display-mode: standalone)').matches);
    if (ios && !installed) { status.textContent = 'On iPhone or iPad, install Stellar on your Home Screen, open it there, then enable notifications.'; return; }
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      status.textContent = 'This browser does not support reminders. Open Stellar in a browser that supports notifications.'; return;
    }
    try {
      const settings = await config();
      if (!settings.enabled) { status.textContent = 'Notifications are not available yet. Your reminder time is saved.'; return; }
      if (Notification.permission === 'denied') { status.textContent = 'Notifications are blocked. Allow them in your browser or device settings, then reopen Stellar.'; return; }
      const reg = await registration();
      let subscription = await reg.pushManager.getSubscription();
      function button(label, fn) {
        const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
        element.addEventListener('click', () => {
          element.disabled = true;
          Promise.resolve(fn()).catch(error => { status.textContent = error.message; })
            .finally(() => { if (element.isConnected) element.disabled = false; });
        });
        actions.appendChild(element); return element;
      }
      function render() {
        actions.replaceChildren();
        if (subscription && Notification.permission === 'granted') {
          status.textContent = 'Notifications are on for this device.';
          button('Send test', async () => {
            await api('/api/notifications/test', 'POST', { endpoint: subscription.endpoint });
            status.textContent = 'Test sent. Check your device notifications.';
          });
          button('Turn off', async () => {
            await api('/api/notifications/subscribe', 'DELETE', { endpoint: subscription.endpoint });
            await subscription.unsubscribe(); subscription = null; render();
          });
        } else {
          status.textContent = 'Enable notifications on this device to receive star reminders.';
          button('Enable notifications', async () => {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') throw Error('Notifications were not enabled. You can allow them in browser settings.');
            subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey(settings.public_key) });
            try { await api('/api/notifications/subscribe', 'POST', subscription.toJSON()); }
            catch (error) { await subscription.unsubscribe(); subscription = null; throw error; }
            render();
          });
        }
      }
      if (subscription && Notification.permission === 'granted') await api('/api/notifications/subscribe', 'POST', subscription.toJSON());
      render();
    } catch (error) { status.textContent = error.message; root.dataset.mounted = ''; }
  }
  window.StellarNotifications = { mount };
  document.querySelectorAll('[data-notification-controls]').forEach(mount);
})();
