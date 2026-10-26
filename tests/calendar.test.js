import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthOf, shiftMonth, monthRange, calendarCells, closesByDate, compactWon } from '../js/calendar.js';

test('월 계산: 영업일 문자열과 Date 모두 지원, 연도 경계 이동', () => {
  assert.equal(monthOf('2026-10-26'), '2026-10');
  assert.equal(monthOf(new Date(2026, 0, 5)), '2026-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
});

test('월 범위: 말일 계산(윤년 포함)', () => {
  assert.deepEqual(monthRange('2026-10'), { from: '2026-10-01', to: '2026-10-31', days: 31 });
  assert.equal(monthRange('2028-02').days, 29);
  assert.equal(monthRange('2026-02').to, '2026-02-28');
});

test('달력 칸: 일요일 시작, 앞뒤 빈칸, 7의 배수', () => {
  // 2026-10-01은 목요일 → 앞 빈칸 4개
  const cells = calendarCells('2026-10');
  assert.deepEqual(cells.slice(0, 5), [null, null, null, null, '2026-10-01']);
  assert.equal(cells.length % 7, 0);
  assert.equal(cells.filter(Boolean).length, 31);
});

test('같은 날 마감 여러 건은 합친다', () => {
  const map = closesByDate([
    { business_date: '2026-10-26', net_total: 96600, payment_count: 2 },
    { business_date: '2026-10-26', net_total: 3400, payment_count: 1 },
    { business_date: '2026-10-25', net_total: 50000, payment_count: 1 },
  ]);
  assert.equal(map.size, 2);
  assert.deepEqual([map.get('2026-10-26').net, map.get('2026-10-26').count], [100000, 3]);
  assert.equal(map.get('2026-10-26').closes.length, 2);
});

test('달력용 짧은 금액(만원 단위)', () => {
  assert.equal(compactWon(96600), '9.7만');
  assert.equal(compactWon(5000), '0.5만');
  assert.equal(compactWon(1234000), '123만');
  assert.equal(compactWon(0), '0');
});
