/* Tasks float within the Pool canvas while its editable stars retain clear
   space beside the panel. Pool stays mounted across range changes so edits
   survive. Compact screens keep the individual views. */
(() => {
  const toggle = document.getElementById('pool-toggle');
  if (!toggle) return;
  const host = document.querySelector('.wrap');
  const pane = document.getElementById('pool-pane');
  const frame = document.getElementById('pool-frame');
  const fallback = document.getElementById('pool-fallback');
  const desktop = matchMedia('(min-width: 1100px)');
  let enabled = true;
  try { enabled = localStorage.getItem('stellar:show-pool') !== 'false'; } catch {}
  let open = false;
  const notify = () => {
    if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'stellar:pool-visibility', visible: open,
      inset: open ? host.querySelector('.dated-tasks').offsetWidth + 48 : 0 }, location.origin);
  };
  const layout = () => {
    const view = document.body.dataset.range || 'day';
    const columns = Math.max(1, Number(document.body.dataset.columns) || 1);
    const minimum = view === 'day' ? 380 : view === 'month' ? 7 * 150 + 48
      : Math.max(380, columns * (columns > 3 ? 168 : 200) + (columns - 1) * 10);
    const navWidth = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-w')) || 172;
    const available = Math.min(document.documentElement.clientWidth, innerWidth - 20) - navWidth - 48;
    const fits = desktop.matches && available >= minimum + 420 + 24;
    open = enabled && fits;
    toggle.hidden = !fits;
    fallback.hidden = !desktop.matches || fits;
    toggle.setAttribute('aria-pressed', String(open));
    toggle.textContent = open ? 'Hide Pool' : 'Show Pool';
    host.classList.toggle('workspace-open', open);
    host.style.setProperty('--workspace-task-width', minimum + 'px');
    pane.hidden = !open;
    if (open && !frame.hasAttribute('src')) frame.src = '/pool?embedded=true';
    notify();
  };
  toggle.addEventListener('click', () => {
    enabled = !enabled;
    try { localStorage.setItem('stellar:show-pool', String(enabled)); } catch {}
    layout();
  });
  frame.addEventListener('load', notify);
  new MutationObserver(layout).observe(document.body, { attributes: true, attributeFilter: ['data-range', 'data-columns'] });
  window.addEventListener('resize', layout);
  window.addEventListener('stellar:sidebar', layout);
  layout();
})();
