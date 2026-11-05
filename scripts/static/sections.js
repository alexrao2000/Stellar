/* Sidebar sections load on demand and retain their own document, charts, drafts,
   and scroll position until the app closes. The initial section stays in place.
   Only the outer window owns browser history; child route changes are mirrored
   there. Inactive sections pause work explicitly (hiding an iframe does not
   change its document visibility). Private content is never persisted to disk. */
(() => {
  const root = document.documentElement;
  const framed = parent !== window && new URLSearchParams(location.search).has('tab_frame');
  let active = true;
  try {
    if (parent !== window) active = framed ? parent.stellarSectionIsActive?.(window) !== false : parent.stellarPageActive?.() !== false;
  } catch {}
  window.stellarPageActive = () => active && !document.hidden;
  window.stellarSetActive = value => {
    const changed = active !== value;
    active = value;
    if (changed) window.dispatchEvent(new Event('stellar:visibility'));
    document.querySelectorAll('iframe').forEach(frame => {
      try { frame.contentWindow?.stellarSetActive?.(value && !frame.hidden && !!frame.getClientRects().length); } catch {}
    });
  };
  document.addEventListener('visibilitychange', () => window.stellarSetActive(active));
  const clean = raw => {
    const url = new URL(raw, location.href);
    url.searchParams.delete('tab_frame');
    return url.pathname + url.search + url.hash;
  };
  const section = raw => {
    const url = new URL(raw, location.origin);
    if (url.origin !== location.origin || url.searchParams.has('embedded')) return null;
    if (['/', '/today'].includes(url.pathname)) return '/';
    return ['/metrics', '/data', '/tasks', '/pool', '/docs'].includes(url.pathname) ? url.pathname : null;
  };
  if (framed) {
    try { root.classList.toggle('sidebar-collapsed', parent.document.documentElement.classList.contains('sidebar-collapsed')); } catch {}
    const replace = history.replaceState.bind(history);
    for (const method of ['pushState', 'replaceState']) {
      history[method] = (state, unused, raw) => {
        const url = new URL(raw || location.href, location.href);
        url.searchParams.set('tab_frame', 'true');
        replace(state, unused, url);
        parent.stellarSectionRoute?.(window, clean(url), state, method);
      };
    }
  }
  function recordsChanged() {
    try { localStorage.setItem('stellar:records-changed', Date.now() + ':' + Math.random()); } catch {}
    window.dispatchEvent(new Event('stellar:records-changed'));
  }
  if (parent !== window) window.stellarRecordsChanged = recordsChanged;
  if (section(location.href) || new URLSearchParams(location.search).has('embedded')) {
    const fetchOriginal = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetchOriginal(...args);
      const request = new URL(args[0] instanceof Request ? args[0].url : args[0], location.href);
      const redirectedToLogin = response.redirected && new URL(response.url).origin === location.origin && new URL(response.url).pathname === '/login';
      if (request.origin === location.origin && (response.status === 401 || redirectedToLogin)) {
        top.location.replace('/login?next=' + encodeURIComponent(clean(top.location.href)));
      }
      return response;
    };
  }
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (!link || link.closest('.sidenav') || event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (!section(url) || section(url) === section(location.href)) return;
    if ((framed ? parent : window).stellarNavigate?.(url)) event.preventDefault();
  });
  if (parent !== window || !section(location.href)) return;
  const nativePush = history.pushState.bind(history), nativeReplace = history.replaceState.bind(history);
  const initial = { key: section(location.href), url: clean(location.href), state: history.state, title: document.title, scroll: 0 };
  const entries = new Map([[initial.key, initial]]);
  let current = initial, replaying = false;
  window.stellarSectionIsActive = source => current.frame?.contentWindow === source;
  document.addEventListener('DOMContentLoaded', () => { initial.title = document.title; });
  const syncSidebar = () => {
    for (const entry of entries.values()) {
      if (!entry.frame) continue;
      try {
        const child = entry.frame.contentWindow;
        for (const name of ['sidebar-collapsed', 'sidebar-animating']) child.document.documentElement.classList.toggle(name, root.classList.contains(name));
        child.document.documentElement.style.setProperty('--mobile-nav-height', getComputedStyle(root).getPropertyValue('--mobile-nav-height'));
        child.dispatchEvent(new Event('stellar:sidebar'));
      } catch {}
    }
  };
  const remember = entry => {
    try {
      localStorage.setItem('stellar:last-location', entry.url);
      if (entry.key === '/' || entry.key === '/metrics') localStorage.setItem('stellar:location:' + (entry.key === '/' ? 'tasks' : 'metrics'), entry.url);
    } catch {}
    document.querySelectorAll('.sidenav a').forEach(link => {
      const key = section(link.href), selected = key === entry.key;
      link.classList.toggle('here', selected);
      if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      if (entries.has(key)) link.href = entries.get(key).url;
    });
  };
  const route = (entry, url, state, method) => {
    entry.url = url; entry.state = state;
    if (entry !== current || replaying) return;
    (method === 'pushState' ? nativePush : nativeReplace)(state, '', url);
    remember(entry);
  };
  for (const method of ['pushState', 'replaceState']) {
    history[method] = (state, unused, raw) => route(initial, clean(raw || initial.url), state, method);
  }
  window.stellarSectionRoute = (source, url, state, method) => {
    const entry = [...entries.values()].find(entry => entry.frame?.contentWindow === source);
    if (entry) route(entry, url, state, method);
  };
  const primaryNodes = () => [...document.body.children].filter(node => !node.matches('.sidenav, script, style, link, #install-dialog, .stellar-section, .stellar-transition-loader'));
  const show = entry => {
    initial.scroll = current === initial ? scrollY : initial.scroll;
    current = entry;
    root.classList.toggle('stellar-section-open', entry !== initial);
    primaryNodes().forEach(node => node.classList.toggle('stellar-primary-hidden', entry !== initial));
    for (const item of entries.values()) if (item.frame) item.frame.hidden = item !== entry;
    window.stellarSetActive(entry === initial);
    if (entry.frame) entry.frame.contentWindow?.stellarSetActive?.(true);
    else scrollTo(0, initial.scroll);
    document.querySelector('.stellar-transition-loader')?.remove();
    if (entry.frame && !entry.ready) {
      const loader = document.createElement('div'); loader.className = 'stellar-transition-loader'; loader.dataset.space = 'true';
      loader.setAttribute('role', 'status');
      loader.innerHTML = '<div class="stellar-loading"><span class="stellar-spinner" aria-hidden="true"></span><span>Loading…</span></div>';
      document.body.append(loader);
    }
    document.title = entry.title || 'Stellar';
    remember(entry); syncSidebar();
  };
  const navigate = (raw, pop = false, state = null) => {
    const key = section(raw);
    if (!key) return false;
    let entry = entries.get(key);
    const url = pop ? clean(raw) : entry?.url || clean(raw);
    if (!entry) {
      const frame = document.createElement('iframe');
      frame.className = 'stellar-section'; frame.title = ({ '/': 'Space', '/data': 'Activity', '/tasks': 'Settings', '/metrics': 'Metrics', '/pool': 'Pool', '/docs': 'API' })[key] + ' · Stellar'; frame.hidden = true;
      entry = { key, url, frame, state, title: 'Stellar' }; entries.set(key, entry);
      const target = new URL(url, location.origin); target.searchParams.set('tab_frame', 'true');
      frame.addEventListener('load', () => {
        try {
          if (frame.contentWindow.location.href === 'about:blank') return;
          if (section(frame.contentWindow.location.href) !== key) { location.replace(clean(frame.contentWindow.location.href)); return; }
          entry.ready = true; entry.title = frame.contentDocument.title;
          if (entry === current) document.querySelector('.stellar-transition-loader')?.remove();
          frame.contentWindow.stellarSetActive?.(entry === current);
          syncSidebar();
          if (entry === current) document.title = entry.title;
        } catch { location.assign(entry.url); }
      });
      document.body.append(frame);
      frame.contentWindow.location.replace(target.href);
    }
    const changedRoute = pop && entry.url !== url;
    if (!pop && entry !== current) nativePush(entry.state, '', entry.url);
    show(entry);
    if (pop) {
      entry.url = url; entry.state = state;
      if (entry.frame && changedRoute) {
        replaying = true;
        const target = new URL(url, location.origin); target.searchParams.set('tab_frame', 'true');
        entry.frame.contentWindow.history.replaceState(state, '', target);
        entry.frame.contentWindow.dispatchEvent(new PopStateEvent('popstate', { state }));
        replaying = false;
      }
      remember(entry);
    }
    return true;
  };
  window.stellarNavigate = navigate;
  window.addEventListener('popstate', event => {
    if (!section(location.href)) return;
    const rootTarget = section(location.href) === initial.key;
    navigate(location.href, true, event.state);
    if (!rootTarget) event.stopImmediatePropagation();
  }, true);
  window.addEventListener('stellar:sidebar', syncSidebar);
  new MutationObserver(syncSidebar).observe(root, { attributes: true, attributeFilter: ['style'] });
  document.addEventListener('visibilitychange', () => { if (current.frame) current.frame.contentWindow?.stellarSetActive?.(true); });
  document.addEventListener('submit', event => {
    if (event.target.matches('form.signout')) entries.forEach(entry => entry.frame?.remove());
  });
})();
