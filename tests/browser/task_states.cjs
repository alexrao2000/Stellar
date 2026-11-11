/* Pure state and daily-goal invariants, including optional bonuses that must
   never substitute for required work. No browser, database, or real records. */
const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
class Clock extends Date { constructor(...args) { super(...(args.length ? args : ['2026-11-05T20:00:00Z'])); } static now() { return Date.parse('2026-11-05T20:00:00Z'); } }
const window = {};
vm.runInNewContext(fs.readFileSync('scripts/static/reports.js', 'utf8'), {
  window: Object.assign(window, { addEventListener() {} }), Date: Clock, setInterval() {},
  document: { documentElement: { classList: { toggle() {} } }, addEventListener() {} },
});
const R = window.StellarReports;
const row = { day: '2026-11-04', status: 'needsAction', is_completed: false, report_due_at: '2026-11-05T07:00:00Z' };
assert.equal(R.state(row), 'incomplete');
assert.equal(R.state({ ...row, optional: true }), 'unreported');
assert.equal(R.state({ ...row, optional: true, status: 'incomplete' }), 'incomplete');
assert.equal(R.state({ ...row, status: 'unreported' }), 'unreported');
const uncertain = { ...row, status: 'unknown' };
assert.equal(R.state(uncertain), 'unknown');
assert.equal(R.resolved(uncertain), false);
assert.equal(R.counts([uncertain]).percent, 0);
assert.equal(R.counts([uncertain]).unknown, 1);
assert.equal(R.state({ ...row, report_due_at: '2026-11-06T07:00:00Z' }), 'unreported');
const required = Array.from({ length: 8 }, () => ({ ...row, is_completed: true }));
const optional = { ...row, optional: true, is_completed: true };
let result = R.counts([...required, optional]);
assert.equal(R.fraction(result), '9/8'); assert.equal(result.percent, 100); assert.equal(result.complete, true);
required[0].is_completed = false;
result = R.counts([...required, optional]);
assert.equal(R.fraction(result), '8/8'); assert.equal(result.requiredDone, 7); assert.equal(result.percent, 87.5); assert.equal(result.complete, false);
assert.equal(R.counts([{ ...optional, is_completed: false }]).unreported, 1);
assert.equal(R.counts([optional]).percent, null);
const week = Array.from({ length: 7 }, (_, i) => ({ ...row, day: '2026-10-' + (20 + i), optional: true, is_completed: i < 3 }));
assert.equal(R.frequency(week), 3);
console.log('Task states: deadline defaults, explicit outcomes, bonus counts, required goals and optional frequency passed');
