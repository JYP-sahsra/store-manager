import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomeByDate, dayFlow, cashBook, shiftDate } from '../js/ledger.js';

const close = (date, cash, card) => ({ business_date: date, cash_total: cash, card_total: card });
const entry = (date, kind, amount, method = null, created_at = '') => ({ business_date: date, kind, amount, method, created_at });

test('날짜 이동(월·연 경계)', () => {
  assert.equal(shiftDate('2026-11-01', -1), '2026-10-31');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
});

test('수입: 일 마감 기록 합계 + 마감 전 영업일', () => {
  const m = incomeByDate([close('2026-11-01', 100000, 50000), close('2026-11-01', 20000, 0)], { date: '2026-11-02', cash: 30000, card: 0 });
  assert.deepEqual(m.get('2026-11-01'), { cash: 120000, card: 50000 });
  assert.deepEqual(m.get('2026-11-02'), { cash: 30000, card: 0 });
});

test('하루 흐름: 수단별 지출, 시재 회수·보충, 순수익, 금고 현금 변화', () => {
  const f = dayFlow(
    [entry('d', 'expense', 20000, 'cash'), entry('d', 'expense', 50000, 'card'), entry('d', 'expense', 10000, 'transfer'),
      entry('d', 'cash_out', 100000), entry('d', 'cash_in', 30000)],
    { cash: 200000, card: 150000 },
  );
  assert.deepEqual([f.cashExpense, f.cardExpense, f.transferExpense, f.expenseTotal], [20000, 50000, 10000, 80000]);
  assert.equal(f.profit, 350000 - 80000);
  assert.equal(f.cashNet, 200000 - 20000 - 100000 + 30000);
});

test('시재: 맞춤을 시작점으로 날짜별 현금 흐름 누적', () => {
  const income = incomeByDate([close('2026-11-01', 200000, 0), close('2026-11-02', 150000, 80000)]);
  const entries = [
    entry('2026-11-01', 'set', 300000),
    entry('2026-11-01', 'expense', 50000, 'cash'),
    entry('2026-11-01', 'cash_out', 150000),
    entry('2026-11-02', 'expense', 40000, 'card'), // 카드 지출은 시재에 영향 없음
    entry('2026-11-02', 'expense', 10000, 'cash'),
  ];
  const d1 = cashBook(entries, income, '2026-11-01');
  assert.deepEqual([d1.start, d1.end], [300000, 300000]); // +200k −50k −150k
  const d2 = cashBook(entries, income, '2026-11-02');
  assert.deepEqual([d2.start, d2.end], [300000, 440000]); // +150k −10k
  // 장부·매출이 없는 날도 전날 마감 시재를 이어받는다
  assert.deepEqual([cashBook(entries, income, '2026-11-03').start, cashBook(entries, income, '2026-11-03').end], [440000, 440000]);
});

test('시재: 나중 맞춤이 기준이 되고, 맞춤 전 날짜는 시작 시재 없음', () => {
  const income = incomeByDate([close('2026-11-01', 100000, 0)]);
  const entries = [entry('2026-11-01', 'set', 300000), entry('2026-11-03', 'set', 280000, null, 'b'), entry('2026-11-03', 'set', 290000, null, 'a')];
  assert.equal(cashBook(entries, income, '2026-10-31').hasStart, false);
  assert.equal(cashBook(entries, income, '2026-11-02').start, 400000);
  assert.equal(cashBook(entries, income, '2026-11-03').start, 280000); // 같은 날 여러 번이면 나중 기록
});
