/* Restore only same-origin app locations on a fresh launch. Explicit links and
   back/forward navigation keep their destinations; embedded modules never own
   the parent selection. Storage failures leave navigation fully usable. */
(() => {
  if (window.top !== window) return;
  const root = document.documentElement;
  const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
  const allowed = new Set(['/', '/today', '/metrics', '/data', '/pool', '/tasks', '/docs', '/weight', '/wake', '/consistency']);
  const safe = raw => {
    if (!raw || raw.length > 2400) return null;
    try { const u = new URL(raw, location.origin); return u.origin === location.origin && allowed.has(u.pathname) && !u.searchParams.has('embedded') ? u.pathname + u.search + u.hash : null; } catch { return null; }
  };
  root.classList.toggle('sidebar-collapsed', read('stellar:sidebar-collapsed') === 'true');
  const legacy = { '/weight': 'weight', '/wake': 'wake', '/consistency': 'overview' };
  if (legacy[location.pathname]) { location.replace('/metrics?tab=' + legacy[location.pathname]); return; }
  let internal = false;
  try { const referrer = new URL(document.referrer); internal = referrer.origin === location.origin && allowed.has(referrer.pathname); } catch {}
  const entry = performance.getEntriesByType('navigation')[0];
  const last = safe(read('stellar:last-location'));
  if (location.pathname === '/' && !location.search && !internal && (!entry || entry.type === 'navigate') && last && last !== '/') {
    location.replace(last);
    return;
  }
  const remember = () => {
    const url = safe(location.href);
    if (!url) return;
    if (!document.hidden && window.stellarPageActive?.() !== false) write('stellar:last-location', url);
    const section = ['/', '/today'].includes(location.pathname) ? 'tasks' : location.pathname === '/metrics' ? 'metrics' : null;
    if (section) write('stellar:location:' + section, url === '/' ? '/?view=day' : url);
    document.querySelectorAll('.sidenav a[data-section]').forEach(a => {
      a.href = safe(read('stellar:location:' + a.dataset.section)) || (a.dataset.section === 'tasks' ? '/?view=day' : '/metrics');
    });
  };
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) { const result = original.apply(this, args); remember(); return result; };
  }
  window.addEventListener('popstate', remember);
  window.addEventListener('focus', remember);
  window.stellarRecordsChanged = () => {
    write('stellar:records-changed', Date.now() + ':' + Math.random());
    window.dispatchEvent(new Event('stellar:records-changed'));
  };
  const init = () => {
    const button = document.querySelector('.sidebar-collapse');
    const desktop = matchMedia('(min-width: 761px)');
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let animationTimer;
    const notifySidebar = () => window.dispatchEvent(new Event('stellar:sidebar'));
    const finishAnimation = () => {
      clearTimeout(animationTimer);
      root.classList.remove('sidebar-animating');
      notifySidebar();
    };
    const sync = () => {
      const collapsed = root.classList.contains('sidebar-collapsed');
      if (button) {
        button.setAttribute('aria-expanded', String(!collapsed));
        button.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
        button.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      }
    };
    button?.addEventListener('click', () => {
      clearTimeout(animationTimer);
      root.classList.toggle('sidebar-animating', desktop.matches && !reducedMotion.matches);
      root.classList.toggle('sidebar-collapsed');
      write('stellar:sidebar-collapsed', String(root.classList.contains('sidebar-collapsed')));
      sync();
      notifySidebar();
      if (root.classList.contains('sidebar-animating')) animationTimer = setTimeout(finishAnimation, 380);
    });
    root.addEventListener('transitionend', event => {
      if (event.target === root && event.propertyName === '--nav-w') finishAnimation();
    });
    desktop.addEventListener('change', finishAnimation);
    reducedMotion.addEventListener('change', finishAnimation);
    document.querySelectorAll('.sidenav a').forEach(a => {
      if (a.getAttribute('href') === '/') a.dataset.section = 'tasks';
      if (a.getAttribute('href') === '/metrics') a.dataset.section = 'metrics';
    });
    sync();
    remember();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
