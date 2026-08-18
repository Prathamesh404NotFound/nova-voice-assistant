const plan = require('../src/main/notes/plan');
plan.setNowForTesting(new Date('2026-08-18T12:00:00Z')); // Wednesday
const cases = [
  ['add finish the report to my tasks by friday', 'notes:add-task', true],
  ['task fix bug due in 3 days', 'notes:add-task', true],
  ['add call dentist to my tasks by next monday', 'notes:add-task', true],
  ['add buy milk to my tasks', 'notes:add-task', false],
  ['add submit invoice to my tasks by tomorrow', 'notes:add-task', true],
  ['add finish the report to my tasks by tuesday and then eat lunch', 'null-ok', null],
  ['by friday', 'null-ok', null],
  ['add book flight for the trip by friday', null, null], // no 'to my tasks' → guidance error (honest)
  ['remind me to stand up at 3pm', 'notes:add-reminder', null],
  ['what did i note about milk', 'notes:search-notes', null],
  ['add finish report to my tasks by this weekend', 'notes:add-task', true],
  ['task submit tax return due end of day', 'notes:add-task', true],
];
let failed = 0;
for (const [c, wantId, wantDue] of cases) {
  const r = plan.planNoteAction(c);
  const got = r ? (r.payload ? { id: r.actionId, due: !!r.payload.dueDate, text: r.payload.text } : { err: r.error }) : null;
  const idOk = wantId === 'null-ok' ? got === null : wantId === null ? got !== null && got.id !== 'notes:add-task' : got && got.id === wantId;
  const dueOk = wantDue === null || (got && got.due === wantDue);
  const ok = idOk && dueOk;
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL '), JSON.stringify(c), '=>', JSON.stringify(got), wantDue !== null ? '(expect due: ' + wantDue + ')' : '');
}
console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILURES');
