/* Installation stays optional. Browsers without an install prompt receive
   platform instructions, and installed windows hide the install controls.
   Navigation paints a star loader before leaving the current document, so
   slow HTML responses keep useful feedback. Entering Space paints its sky. */
(() => {
  const syncTheme = () => {
    const color = getComputedStyle(document.body).getPropertyValue('--surface').trim();
    if (color) document.querySelectorAll('meta[name=theme-color]').forEach(meta => { meta.content = color; });
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  syncTheme();
  const standalone = matchMedia('(display-mode: standalone)');
  const dialog = document.getElementById('install-dialog');
  const buttons = document.querySelectorAll('[data-install]');
  const native = document.getElementById('install-native');
  const instructions = document.getElementById('install-instructions');
  const feedback = document.getElementById('install-feedback');
  let prompt = null;

  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function sync() {
    const installed = standalone.matches || navigator.standalone === true;
    buttons.forEach(button => { button.hidden = installed; });
    if (installed && dialog.open) dialog.close();
    native.hidden = !prompt;
    instructions.innerHTML = prompt
      ? '<p>Tap <strong>Install app</strong> below to add Stellar to your device.</p>'
      : ios
        ? '<ol><li>Open <strong>Share</strong> in your current browser. It may be inside the <strong>⋯</strong> menu.</li>' +
          '<li>Choose <strong>Add to Home Screen</strong>.</li>' +
          '<li>Keep <strong>Open as Web App</strong> on, if shown, then tap <strong>Add</strong>.</li></ol>' +
          '<p>If the option is missing, update your browser or open this page in a browser that supports home-screen apps.</p>'
        : '<ol><li>Open your browser menu or its install icon in the address bar.</li>' +
          '<li>Choose <strong>Install app</strong>, <strong>Install</strong>, or <strong>Add to Home Screen</strong>.</li>' +
          '<li>Confirm with <strong>Install</strong> or <strong>Add</strong>.</li></ol>';
  }

  buttons.forEach(button => button.addEventListener('click', () => {
    feedback.textContent = '';
    sync();
    dialog.showModal();
  }));
  native.addEventListener('click', async () => {
    const pending = prompt;
    if (!pending) return;
    prompt = null;
    sync();
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
    let navigationVersion = 0;
    const clearTransition = () => {
      navigationVersion++;
      document.querySelector('.stellar-transition-loader')?.remove();
    };
    nav.addEventListener('click', event => {
      const link = event.target.closest('a[href]');
      if (!link || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
          link.target || link.hasAttribute('download')) return;
      const url = new URL(link.href, location.origin);
      if (url.origin !== location.origin) return;
      event.preventDefault();
      clearTransition();
      const version = navigationVersion;
      const overlay = document.createElement('div');
      overlay.className = 'stellar-transition-loader'; overlay.setAttribute('role', 'status');
      overlay.dataset.space = 'true';
      const loading = document.createElement('div'); loading.className = 'stellar-loading';
      const spinner = document.createElement('span'); spinner.className = 'stellar-spinner'; spinner.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span'); label.textContent = 'Loading ' + (link.getAttribute('aria-label') || 'Stellar') + '…';
      loading.append(spinner, label); overlay.append(loading);
      document.body.append(overlay);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (version === navigationVersion) {
          window.dispatchEvent(new Event('stellar:navigate'));
          location.assign(url.href);
        }
      }));
    });
    window.addEventListener('pagehide', clearTransition);
    window.addEventListener('pageshow', clearTransition);
    window.addEventListener('keydown', event => { if (event.key === 'Escape') clearTransition(); });
    const toggle = nav.querySelector('.nav-toggle');
    const setMenu = open => {
      nav.classList.toggle('menu-open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
    nav.querySelector('.nav-links').addEventListener('click', event => {
      if (event.target.closest('a')) setMenu(false);
    });
    document.addEventListener('click', event => { if (!nav.contains(event.target)) setMenu(false); });
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setMenu(false);
        toggle.focus();
        event.stopPropagation();
      }
    }, true);
    const measure = () => document.documentElement.style.setProperty('--mobile-nav-height', nav.offsetHeight + 'px');
    new ResizeObserver(measure).observe(nav);
    matchMedia('(max-width: 760px)').addEventListener('change', () => setMenu(false));
    measure();
  }
  if (window.visualViewport) {
    const measureViewport = () => document.documentElement.style.setProperty(
      '--keyboard-inset', Math.max(0, innerHeight - visualViewport.height - visualViewport.offsetTop) + 'px'
    );
    visualViewport.addEventListener('resize', measureViewport);
    visualViewport.addEventListener('scroll', measureViewport);
    measureViewport();
  }
  if (window.parent !== window && ['weight', 'wake', 'consistency'].includes(document.body.dataset.page)) {
    let queued = false;
    const resize = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        parent.postMessage({ type: 'stellar:metric-height', url: location.pathname + location.search,
          height: document.body.getBoundingClientRect().height,
          ready: !!document.body.dataset.metricReady && !document.documentElement.classList.contains('app-booting'),
          failed: document.body.dataset.metricReady === 'error' }, location.origin);
      });
    };
    new ResizeObserver(resize).observe(document.body);
    new MutationObserver(resize).observe(document.body, { attributes: true, attributeFilter: ['data-metric-ready'] });
    new MutationObserver(resize).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('load', resize);
    resize();
  }
})();
