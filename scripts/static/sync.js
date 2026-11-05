/* One visible app window polls three tiny database revision counters. Cached
   sections share it and refresh only their changed domains. Drafts and pending
   writes can defer a refresh without acknowledging the revision. Requests never
   overlap, hidden windows pause, and failures back off without clearing the UI. */
(() => {
  const scopes = ['records', 'definitions', 'pool'];
  let root;
  try { root = top === window ? null : top.StellarSync; } catch {}
  if (top !== window) {
    window.StellarSync = {
      get managed() { return root?.managed === true; },
      subscribe(domains, refresh) { return root?._register(window, domains, refresh) || (() => {}); },
      check() { root?.check(); }, retry() { root?.retry(); },
    };
  } else {
    const entries = new Set();
    let versions = null, etag = '', timer, retryTimer, busy = false, again = false, delay = 10000, stopped = false;
    const visible = owner => {
      try { return !owner.document.hidden && owner.stellarPageActive?.() !== false &&
        (owner === window || !owner.frameElement.hidden && owner.frameElement.getClientRects().length > 0); } catch { return false; }
    };
    const dirty = entry => versions && entry.domains.some(scope => entry.seen[scope] !== versions[scope]);
    const pump = () => {
      if (document.hidden || stopped || !versions) return;
      entries.forEach(entry => {
        if (entry.busy || !dirty(entry) || !visible(entry.owner)) return;
        const observed = { ...versions };
        entry.busy = true;
        Promise.resolve().then(entry.refresh).then(applied => {
          if (applied === true) entry.domains.forEach(scope => { entry.seen[scope] = observed[scope]; });
          return applied;
        }).catch(() => false).finally(() => { entry.busy = false; });
      });
    };
    const retry = () => { clearTimeout(retryTimer); retryTimer = setTimeout(pump, 250); };
    const check = async () => {
      clearTimeout(timer);
      if (stopped || document.hidden || !navigator.onLine) return;
      if (busy) { again = true; return; }
      busy = true;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch('/api/changes', { cache: 'no-store', priority: 'low', signal: controller.signal,
          headers: etag ? { 'If-None-Match': etag } : {} });
        if (response.status !== 304) {
          if (!response.ok) throw Error('Sync unavailable');
          const data = await response.json();
          if (!scopes.every(scope => /^\d+$/.test(String(data[scope])))) throw Error('Invalid revisions');
          versions = Object.fromEntries(scopes.map(scope => [scope, String(data[scope])]));
          etag = response.headers.get('ETag') || '';
        }
        delay = 10000; pump();
      } catch { delay = Math.min(120000, delay * 2); }
      finally {
        clearTimeout(timeout); busy = false;
        if (!stopped && !document.hidden) { timer = setTimeout(check, again ? 0 : delay); again = false; }
      }
    };
    const register = (owner, domains, refresh) => {
      const entry = { owner, domains: domains.filter(scope => scopes.includes(scope)), refresh, seen: {}, busy: false };
      entries.add(entry); retry();
      const remove = () => entries.delete(entry);
      owner.addEventListener('pagehide', event => { if (!event.persisted) remove(); });
      return remove;
    };
    window.StellarSync = { get managed() { return versions !== null; }, _register: register,
      subscribe(domains, refresh) { return register(window, domains, refresh); }, check, retry };
    const wake = () => { delay = 10000; check(); retry(); };
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); else clearTimeout(timer); });
    window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); clearTimeout(retryTimer); });
    window.addEventListener('pageshow', event => { stopped = false; if (event.persisted) wake(); });
    const start = () => {
      if (!['/', '/today', '/metrics', '/data', '/tasks', '/pool', '/docs'].includes(location.pathname)) return;
      timer = setTimeout(check, 1200);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  }
  window.addEventListener('stellar:records-changed', () => window.StellarSync?.check());
  window.addEventListener('stellar:visibility', () => window.StellarSync?.retry());
  document.addEventListener('focusout', () => window.StellarSync?.retry());
  document.addEventListener('change', () => window.StellarSync?.retry());
})();
