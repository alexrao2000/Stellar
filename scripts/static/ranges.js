/* The shorter ranges compare tasks without repeating their names for each day.
   Phones show one day's full-size controls beneath a date strip. Measurement
   editors reuse the existing save handlers; date changes and resizing use the
   same cached records. Day and Month keep their original renderers. */
(() => {
  const phone = matchMedia('(max-width: 760px)');
  let focused = null, current = null;
  const shortTitle = (row, ctx) => row.title === ctx.weight ? 'Weight' : row.title === ctx.wake ? 'Wake up' : row.title;
  const valueFor = (row, ctx) => {
    if (row.title === ctx.weight) return row.weight_lbs == null ? '—' : Number(row.weight_lbs).toFixed(1);
    const time = ctx.wakeValue(row.notes);
    return time ? time.value : '—';
  };
  function paintValue(row, button, ctx) {
    button.textContent = valueFor(row, ctx);
    button.dataset.completed = String(!!row.is_completed);
    button.setAttribute('aria-label', button.dataset.label + ', ' + valueFor(row, ctx) + ', ' + StellarReports.labels[StellarReports.state(row)]);
    button.title = button.getAttribute('aria-label');
  }
  function closeEditor() {
    document.querySelector('.range-editor')?.close();
  }
  function editValue(row, button, ctx, changed) {
    closeEditor();
    const dialog = document.createElement('dialog'); dialog.className = 'range-editor';
    const title = document.createElement('h2'); title.textContent = shortTitle(row, ctx); title.id = 'range-editor-title';
    const date = document.createElement('p'); date.textContent = ctx.label(row.day, { weekday: 'long', month: 'short', day: 'numeric' });
    const editor = ctx.field(row, false, () => { paintValue(row, button, ctx); if (statusButton) statusButton.textContent = 'Status: ' + StellarReports.labels[StellarReports.state(row)]; changed(); });
    const statusButton = editor.querySelector('.report-measure-status');
    if (statusButton) { statusButton.className = 'report-field-status'; statusButton.setAttribute('aria-label', 'Set ' + title.textContent + ' status'); statusButton.textContent = 'Status: ' + StellarReports.labels[StellarReports.state(row)]; }
    const input = editor.querySelector('input');
    input.setAttribute('aria-label', title.textContent + ', ' + date.textContent);
    const originalValue = input.value;
    const done = document.createElement('button'); done.type = 'button'; done.className = 'range-editor-done'; done.textContent = 'Done';
    done.addEventListener('click', () => { input.blur(); dialog.close(); });
    dialog.setAttribute('aria-labelledby', title.id);
    dialog.append(title, date, editor); if (statusButton) dialog.append(statusButton); dialog.append(done); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); input.value = originalValue; dialog.close(); });
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); dialog.close(); }
    });
    dialog.addEventListener('close', () => { dialog.remove(); if (button.isConnected) button.focus({ preventScroll: true }); });
    dialog.showModal(); input.focus();
    if (input.type === 'number') input.select();
  }
  window.stellarRenderRange = ctx => {
    current = ctx; closeEditor();
    const { board, days } = ctx;
    const requested = new URLSearchParams(location.search).get('focus');
    if (days.includes(requested)) focused = requested;
    if (!days.includes(focused)) focused = days.includes(ctx.today) ? ctx.today : days.includes(ctx.day) ? ctx.day : days[0];
    board.classList.add('range-board');
    const updateProgress = StellarReports.progress(board, () => days.filter(day => day <= ctx.today).flatMap(day => ctx.rows(day)));
    const doneFor = day => ctx.rows(day).filter(row => row.is_completed).length;
    const dateLabel = day => ctx.label(day, { weekday: 'long', month: 'short', day: 'numeric' });
    const dateButton = day => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'range-date'; button.dataset.day = day;
      button.classList.toggle('is-today', day === ctx.today); button.classList.toggle('is-future', day > ctx.today);
      button.innerHTML = '<span class="range-weekday"></span><span class="range-number"></span><span class="range-count"></span>';
      button.querySelector('.range-weekday').textContent = ctx.label(day, ctx.view === 'custom' && !phone.matches || day.endsWith('-01') ? { month: 'short' } : { weekday: 'short' });
      button.querySelector('.range-number').textContent = ctx.label(day, { day: 'numeric' });
      if (day === ctx.today) button.setAttribute('aria-current', 'date');
      return button;
    };
    const changed = () => {
      updateProgress();
      board.querySelectorAll('.range-date').forEach(button => {
        const day = button.dataset.day, total = ctx.owed(ctx.rows(day));
        button.querySelector('.range-count').textContent = day > ctx.today ? '·' : StellarReports.fraction(StellarReports.counts(ctx.rows(day)));
        button.setAttribute('aria-label', (phone.matches ? 'Show ' : 'Open ') + dateLabel(day) + (day > ctx.today ? ', upcoming' : ', ' + StellarReports.description(StellarReports.counts(ctx.rows(day)))));
      });
    };
    if (phone.matches) {
      const strip = document.createElement('div'); strip.className = 'range-dates'; strip.setAttribute('role', 'group'); strip.setAttribute('aria-label', 'Days in range');
      const focus = document.createElement('div'); focus.className = 'range-focus';
      const select = (day, remember = false) => {
        focused = day;
        if (remember) {
          const url = new URL(location.href); url.searchParams.set('focus', day);
          history.replaceState(history.state, '', url.pathname + url.search);
        }
        strip.querySelectorAll('button').forEach(button => { button.setAttribute('aria-pressed', String(button.dataset.day === day)); button.tabIndex = button.dataset.day === day ? 0 : -1; });
        focus.replaceChildren(ctx.column(day, changed));
        const head = focus.querySelector('.col-head');
        const label = document.createElement('span'); label.className = 'range-focus-label'; label.textContent = dateLabel(day);
        head.replaceChildren(label); head.setAttribute('aria-label', 'Open ' + dateLabel(day) + ' in Day view');
      };
      days.forEach(day => { const button = dateButton(day); button.addEventListener('click', () => select(day, true)); strip.append(button); });
      strip.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const index = days.indexOf(focused);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? days.length - 1 : Math.max(0, Math.min(days.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
        select(days[next], true);
        const button = strip.querySelector('[aria-pressed=true]'); button.focus({ preventScroll: true });
        strip.scrollLeft = button.offsetLeft - strip.offsetLeft - (strip.clientWidth - button.offsetWidth) / 2;
      });
      board.append(strip, focus); select(focused); changed();
      const selected = strip.querySelector('[aria-pressed=true]');
      strip.scrollLeft = selected.offsetLeft - strip.offsetLeft - (strip.clientWidth - selected.offsetWidth) / 2;
      return;
    }
    const scroll = document.createElement('div'); scroll.className = 'range-scroll'; scroll.tabIndex = 0;
    scroll.addEventListener('keydown', event => { if (event.key.startsWith('Arrow')) event.stopPropagation(); });
    scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Task records by day');
    const table = document.createElement('table'); table.className = 'range-table';
    table.style.setProperty('--range-days', days.length);
    const caption = document.createElement('caption'); caption.textContent = 'Task records, ' + dateLabel(days[0]) + ' to ' + dateLabel(days.at(-1)); caption.className = 'range-sr'; table.append(caption);
    const columns = document.createElement('colgroup'); columns.append(document.createElement('col'));
    days.forEach(() => columns.append(document.createElement('col'))); table.append(columns);
    const thead = document.createElement('thead'), header = document.createElement('tr');
    const corner = document.createElement('th'); corner.scope = 'col'; corner.className = 'range-task-heading'; corner.textContent = 'Tasks'; header.append(corner);
    days.forEach(day => {
      const th = document.createElement('th'); th.scope = 'col';
      const button = dateButton(day); button.addEventListener('click', () => ctx.go('day', day)); th.append(button); header.append(th);
    });
    thead.append(header); table.append(thead);
    const body = document.createElement('tbody');
    const allRows = days.flatMap(day => ctx.rows(day));
    const titles = [...new Set(allRows.map(row => row.title))];
    titles.forEach(title => {
      const tr = document.createElement('tr'), name = document.createElement('th'); name.scope = 'row'; name.className = 'range-task-name';
      const row = allRows.find(row => row.title === title);
      const label = document.createElement('span'); label.textContent = shortTitle(row, ctx); name.append(label); name.title = title; tr.append(name);
      days.forEach(day => {
        const td = document.createElement('td'), row = ctx.rows(day).find(row => row.title === title);
        td.classList.toggle('range-today', day === ctx.today);
        if (!row) { td.textContent = '—'; td.classList.add('range-absent'); tr.append(td); return; }
        const locked = day > ctx.today || !ctx.writable(day);
        if (title === ctx.weight || title === ctx.wake) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'range-value';
          button.disabled = locked;
          button.dataset.label = shortTitle(row, ctx) + ', ' + dateLabel(day);
          button.setAttribute('aria-haspopup', 'dialog');
          paintValue(row, button, ctx);
          button.addEventListener('click', () => editValue(row, button, ctx, changed)); td.append(button);
        } else {
          const button = ctx.tile(row, locked, changed, true); td.append(button);
        }
        tr.append(td);
      });
      body.append(tr);
    });
    if (!titles.length) {
      const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = days.length + 1; td.className = 'range-empty'; td.textContent = 'Nothing scheduled in this range.'; tr.append(td); body.append(tr);
    }
    table.append(body); scroll.append(table); board.append(scroll);
    const hint = document.createElement('p'); hint.className = 'range-hint'; hint.textContent = 'Select a date to open its day.';
    if (days.length > 7) hint.textContent += ' Scroll across to compare more days.';
    board.append(hint); changed();
  };
  phone.addEventListener('change', () => {
    if (!current?.board.classList.contains('range-board') || !['3days', 'week', 'custom'].includes(document.body.dataset.range)) return;
    current.board.replaceChildren(); window.stellarRenderRange(current);
  });
})();
