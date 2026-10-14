import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const code = readFileSync(fileURLToPath(new URL('../dist/engine.js', import.meta.url)), 'utf8');
const context = vm.createContext({ Date, console });
vm.runInContext(code, context);
const engine = context.HokiiEngine;
const scenario = id => JSON.parse(JSON.stringify(engine.getScenario(id)));
const result = state => engine.evaluate(state);
const codes = axis => axis.reasons.map(reason => reason.code);
const dayAfter = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

test('six complete synthetic scenarios exist and have source evidence', () => {
  assert.equal(engine.scenarios.length, 6);
  for (const entry of engine.scenarios) {
    const state = scenario(entry.id);
    assert.ok(state.document.text.includes('合成'));
    assert.ok(state.document.evidence.every(e => e.source && e.quote));
    assert.equal(result(state).cash.points.length, state.cash.balance === null ? 0 : 30);
  }
});
test('normal payment has two green axes and is eligible for human review', () => {
  const evaluated = result(scenario('normal'));
  assert.equal(evaluated.safety.level, 'green');
  assert.equal(evaluated.cash.level, 'green');
  assert.equal(evaluated.readyForReview, true);
  assert.equal(evaluated.cash.currentAfterPayment, 670000);
});
test('unverified account change blocks review even with a yellow light', () => {
  const evaluated = result(scenario('change-legit'));
  assert.equal(evaluated.safety.level, 'yellow');
  assert.equal(evaluated.readyForReview, false);
});
test('trusted callback record clears changed account but preserves original baseline', () => {
  const state = scenario('change-legit');
  const original = state.suppliers[0].accounts[0];
  state.verification = { accountChangeConfirmed: true, by: '測試老闆', note: '以原先保存電話回撥，原窗口確認新帳號。' };
  const evaluated = result(state);
  assert.equal(evaluated.safety.level, 'green');
  assert.equal(evaluated.readyForReview, true);
  assert.ok(codes(evaluated.safety).includes('VERIFIED_ACCOUNT_CHANGE'));
  assert.equal(state.suppliers[0].accounts[0], original);
});
test('checkbox alone is not sufficient verification', () => {
  const state = scenario('change-legit');
  state.verification.accountChangeConfirmed = true;
  assert.equal(result(state).readyForReview, false);
});
test('callback record bound to another account cannot verify the current account', () => {
  const state = scenario('change-legit');
  state.verification = { accountChangeConfirmed: true, by: '老闆', note: '舊帳號查證', account: '01212345678901' };
  assert.equal(result(state).safety.level, 'yellow');
  assert.equal(result(state).readyForReview, false);
});
test('urgency plus account change produces red until verified', () => {
  const state = scenario('suspicious');
  assert.equal(result(state).safety.level, 'red');
  state.verification = { accountChangeConfirmed: true, by: '原窗口確認人', note: '原先可信窗口確認，留存查證紀錄。' };
  assert.equal(result(state).safety.level, 'green');
});
test('previous paid invoice blocks review, unrelated supplier does not', () => {
  const state = scenario('duplicate');
  assert.equal(result(state).safety.level, 'red');
  assert.ok(codes(result(state).safety).includes('DUPLICATE_PAID_INVOICE'));
  state.history[state.history.length - 1].supplierId = 'ANOTHER-SUPPLIER';
  assert.equal(result(state).safety.level, 'green');
});
test('cash gap is exactly 210000 with salary date identified', () => {
  const state = scenario('cash-gap');
  const cash = result(state).cash;
  assert.equal(cash.level, 'red');
  assert.equal(cash.minBalance, -210000);
  assert.equal(cash.gap, 210000);
  assert.equal(cash.minDate, state.schedule[0].date);
});
test('linked payment schedule is deducted exactly once', () => {
  const state = scenario('normal');
  state.cash.balance = 120000;
  state.cash.reserve = 0;
  state.schedule = [{ id: 'LINK', date: state.payment.dueDate, type: 'out', amount: 120000, label: '本次請款', certainty: 'confirmed', linkedPaymentId: state.payment.id }];
  const cash = result(state).cash;
  assert.equal(cash.minBalance, 0);
  assert.equal(cash.points[0].balance, 0);
  assert.equal(cash.level, 'green');
});
test('similar text without explicit link remains an independent expense', () => {
  const state = scenario('normal');
  state.cash.balance = 120000;
  state.cash.reserve = 0;
  state.schedule = [{ id: 'OTHER', date: state.payment.dueDate, type: 'out', amount: 120000, label: state.payment.invoiceNo, certainty: 'confirmed' }];
  assert.equal(result(state).cash.minBalance, -120000);
});
test('linked draft conflict produces gray and avoids double deduction', () => {
  const state = scenario('normal');
  state.schedule.push({ id: 'LINK', date: state.payment.dueDate, type: 'out', amount: 1, label: '本次請款', certainty: 'confirmed', linkedPaymentId: state.payment.id });
  const evaluated = result(state);
  assert.equal(evaluated.cash.level, 'gray');
  assert.ok(codes(evaluated.cash).includes('LINKED_PAYMENT_CONFLICT'));
  assert.equal(evaluated.cash.currentAfterPayment, 670000);
});
test('missing salary confirmation dominates otherwise green or red cash preview', () => {
  const state = scenario('cash-gap');
  state.cash.scheduleComplete = false;
  assert.equal(result(state).cash.level, 'gray');
  assert.equal(result(state).cash.gap, 210000);
  assert.equal(result(state).readyForReview, false);
});
test('null balance never coerces into zero', () => {
  const evaluated = result(scenario('missing'));
  assert.equal(evaluated.cash.level, 'gray');
  assert.equal(evaluated.cash.minBalance, null);
  assert.equal(evaluated.cash.gap, null);
  assert.equal(evaluated.readyForReview, false);
});
test('expected receipts are delayed seven days only in stress scenario', () => {
  const state = scenario('normal');
  state.cash.balance = 150000;
  state.cash.reserve = 0;
  state.schedule = [
    { id: 'IN', date: dayAfter(state.cash.balanceDate, 1), type: 'in', amount: 100000, label: '預期入帳', certainty: 'expected' },
    { id: 'OUT', date: dayAfter(state.cash.balanceDate, 2), type: 'out', amount: 80000, label: '薪資', certainty: 'confirmed' }
  ];
  const cash = result(state).cash;
  assert.equal(cash.minBalance, 30000);
  assert.equal(cash.stressMinBalance, -50000);
  assert.equal(cash.level, 'yellow');
  assert.equal(cash.points[8].stressBalance, 50000);
  state.schedule[0].certainty = 'confirmed';
  assert.equal(result(state).cash.level, 'green');
});
test('snapshot invalidates changed account, amount, schedule metadata and documents', () => {
  const state = scenario('normal');
  const approved = engine.snapshot(state);
  for (const mutate of [
    s => { s.payment.account = '82200000000000'; },
    s => { s.payment.amount++; },
    s => { s.schedule[0].certainty = 'confirmed'; },
    s => { s.document.text += '\n新附件'; },
    s => { s.verification.note = '更新查證'; }
  ]) {
    const modified = JSON.parse(JSON.stringify(state));
    mutate(modified);
    assert.notEqual(engine.snapshot(modified), approved);
  }
  assert.equal(engine.snapshot({ ...state, approval: { by: '老闆' } }), approved);
});
test('snapshot is independent of object key insertion order', () => {
  assert.equal(engine.snapshot({ payment: { account: '1', amount: 2 } }), engine.snapshot({ payment: { amount: 2, account: '1' } }));
});
test('past due payment, old balance or past schedule require refreshed data', () => {
  for (const modify of [
    s => { s.payment.dueDate = dayAfter(s.cash.balanceDate, -1); },
    s => { s.cash.balanceDate = dayAfter(s.cash.balanceDate, -4); },
    s => { s.schedule[0].date = dayAfter(s.cash.balanceDate, -1); }
  ]) {
    const state = scenario('normal');
    modify(state);
    assert.equal(result(state).cash.level, 'gray');
  }
});
test('large amount requires at least three paid history samples', () => {
  const state = scenario('normal');
  state.payment.amount = 310000;
  assert.ok(codes(result(state).safety).includes('AMOUNT_OUTLIER'));
  state.history = state.history.slice(0, 2);
  assert.ok(!codes(result(state).safety).includes('AMOUNT_OUTLIER'));
});
test('money is computed in integer cents', () => {
  const state = scenario('normal');
  state.cash.balance = 0.3;
  state.cash.reserve = 0;
  state.payment.amount = 0.1;
  state.schedule = [{ id: 'SMALL', date: state.payment.dueDate, type: 'out', amount: 0.2, label: '分', certainty: 'confirmed' }];
  assert.equal(result(state).cash.minBalance, 0);
});
test('payment day ending balance includes other same-day cash flows', () => {
  const state = scenario('normal');
  state.payment.dueDate = dayAfter(state.cash.balanceDate, 5);
  const cash = result(state).cash;
  assert.equal(cash.currentAfterPayment, 790000);
  assert.equal(cash.paymentDayBalance, 850000);
});
test('malformed optional array entries fail safely instead of crashing', () => {
  const state = scenario('normal');
  state.suppliers.unshift(null);
  state.history.unshift(null);
  state.schedule.push(null);
  assert.equal(result(state).cash.level, 'gray');
  assert.equal(result({}).readyForReview, false);
});
test('invalid numeric text and invalid dates are not silently accepted', () => {
  const state = scenario('normal');
  state.payment.amount = '120000';
  state.payment.dueDate = '2026-02-31';
  assert.equal(result(state).safety.level, 'gray');
  assert.equal(result(state).cash.level, 'gray');
});
test('evaluation does not mutate input state', () => {
  const state = scenario('normal');
  const before = JSON.stringify(state);
  result(state);
  assert.equal(JSON.stringify(state), before);
});
