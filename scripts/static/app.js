/* Installation stays optional. Browsers without an install prompt receive
   platform instructions, and installed windows hide the install controls. */
(() => {
  const standalone = matchMedia('(display-mode: standalone)');
  const dialog = document.getElementById('install-dialog');
  const buttons = document.querySelectorAll('[data-install]');
  const native = document.getElementById('install-native');
  const instructions = document.getElementById('install-instructions');
  const feedback = document.getElementById('install-feedback');
  let prompt = null;

  function sync() {
    const installed = standalone.matches || navigator.standalone === true;
    buttons.forEach(button => { button.hidden = installed; });
    if (installed && dialog.open) dialog.close();
    native.hidden = !prompt;
  }

  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  instructions.innerHTML = ios
    ? '<ol><li>Open this page in Safari.</li><li>Tap the Share button in the browser menu.</li>' +
      '<li>Choose <strong>Add to Home Screen</strong>.</li><li>Keep <strong>Open as Web App</strong> on, if shown, and tap <strong>Add</strong>.</li></ol>'
    : '<p>Tap <strong>Install app</strong> below when available. You can also use your browser menu ' +
      'and choose <strong>Install app</strong> or <strong>Add to Home Screen</strong>.</p>';
  buttons.forEach(button => button.addEventListener('click', () => {
    feedback.textContent = '';
    sync();
    dialog.showModal();
  }));
  native.addEventListener('click', async () => {
    const pending = prompt;
    if (!pending) return;
    prompt = null;
    native.hidden = true;
    try {
      await pending.prompt();
      const choice = await pending.userChoice;
      if (choice.outcome === 'accepted') dialog.close();
      else feedback.textContent = 'You can install later from your browser menu.';
    } catch {
      feedback.textContent = 'Use your browser menu to install the app.';
    }
  });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    prompt = event;
    sync();
  });
  window.addEventListener('appinstalled', () => {
    prompt = null;
    buttons.forEach(button => { button.hidden = true; });
    dialog.close();
  });
  standalone.addEventListener('change', sync);
  sync();

  if (navigator.serviceWorker && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    });
  }
  const nav = document.querySelector('.sidenav');
  if (nav) {
    const measure = () => document.documentElement.style.setProperty('--mobile-nav-height', nav.offsetHeight + 'px');
    new ResizeObserver(measure).observe(nav);
    nav.querySelector('.here')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
  }
})();
