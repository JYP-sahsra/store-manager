import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  unpaidLines,
  sumLines,
  calcPayment,
  markSessionPaid,
  changeCount,
  summarizeDay,
  businessDate,
  buildCloseRecord,
  isStaleBusinessDay,
  HOURS_KEY,
  addService,
  changeServiceHours,
  removeService,
  setServiceStart,
  serviceEndAt,
  serviceStatus,
  serviceMinutesLeft,
  withTimeOfDay,
} from '../js/calc.js';

const room = { id: 'room1', name: '1번 룸', hourlyRate: 30000 };
const items = [
  { id: 'beer', name: '맥주', category: 'liquor', price: 8000, active: true },
  { id: 'fruit', name: '과일안주', category: 'service', price: 25000, active: true },
];
const emptySession = () => ({
  id: 's1',
  startedAt: '2026-10-26T20:00:00.000Z',
  hours: 0,
  quantities: {},
  paidHours: 0,
  paidQuantities: {},
});

function pay(session, method, discount) {
  const lines = unpaidLines(session, room, items);
  const result = calcPayment(sumLines(lines), method, discount);
  return {
    payment: { roomId: room.id, roomName: room.name, method, lines, coveredBase: result.base, ...result },
    session: markSessionPaid(session),
  };
}

test('선불 현금 결제 후 연장분만 카드로 중간 결제하고 잔액 0', () => {
  let s = emptySession();
  s = changeCount(s, HOURS_KEY, 1);
  s = changeCount(s, HOURS_KEY, 1);
  s = changeCount(s, 'beer', 2);
  assert.equal(sumLines(unpaidLines(s, room, items)), 2 * 30000 + 2 * 8000);

  const first = pay(s, 'cash', 0);
  assert.equal(first.payment.amount, 76000);
  s = first.session;
  assert.equal(sumLines(unpaidLines(s, room, items)), 0);

  s = changeCount(s, HOURS_KEY, 1);
  s = changeCount(s, 'beer', 1);
  const lines = unpaidLines(s, room, items);
  assert.deepEqual(
    lines.map((l) => [l.kind, l.qty, l.subtotal]),
    [['room', 1, 30000], ['liquor', 1, 8000]],
  );

  const second = pay(s, 'card', 5000);
  // 38,000 + 3,800 − 5,000
  assert.equal(second.payment.surcharge, 3800);
  assert.equal(second.payment.amount, 36800);
  assert.equal(sumLines(unpaidLines(second.session, room, items)), 0);
});

test('시간제 서비스: 1인 1건, 단가 × 시간, 서로 다른 시작 시각, 결제 후 연장분만 청구', () => {
  const hostess = { id: 'svc', name: '도우미', category: 'service', price: 40000, active: true };
  const all = [...items, hostess];
  let s = emptySession();
  s = addService(s, 'svc', new Date(2026, 9, 26, 21, 0).toISOString(), 'a');
  s = addService(s, 'svc', new Date(2026, 9, 26, 21, 30).toISOString(), 'b');
  s = changeServiceHours(s, 'a', 1); // a: 2시간, b: 1시간
  const lines = unpaidLines(s, room, all).filter((l) => l.kind === 'service');
  assert.deepEqual(lines.map((l) => [l.serviceId, l.qty, l.subtotal]), [['a', 2, 80000], ['b', 1, 40000]]);
  assert.ok(lines[0].startedAt);

  // 결제 전에는 시간이 남아 있어도 잘못 추가한 서비스를 지울 수 있다
  const extra = addService(s, 'svc', new Date().toISOString(), 'c');
  assert.deepEqual(removeService(extra, 'c').services.map((v) => v.id), ['a', 'b']);

  s = markSessionPaid(s);
  assert.equal(sumLines(unpaidLines(s, room, all)), 0);
  assert.equal(changeServiceHours(s, 'b', -1), s); // 결제한 시간 아래로 못 줄임
  assert.equal(removeService(s, 'b'), s); // 결제 기록이 있으면 못 지움
  s = changeServiceHours(s, 'b', 1);
  assert.deepEqual(unpaidLines(s, room, all).map((l) => [l.serviceId, l.qty]), [['b', 1]]);
});

test('시간제 서비스 종료 예정 시각과 상태(10분 전 강조, 지나면 초과)', () => {
  let s = addService(emptySession(), 'svc', new Date(2026, 9, 26, 21, 0).toISOString(), 'a');
  s = changeServiceHours(s, 'a', 1);
  const svc = s.services[0];
  assert.equal(new Date(serviceEndAt(svc)).getHours(), 23);
  assert.equal(serviceStatus(svc, new Date(2026, 9, 26, 22, 0)), 'running');
  assert.equal(serviceStatus(svc, new Date(2026, 9, 26, 22, 50)), 'ending');
  assert.equal(serviceStatus(svc, new Date(2026, 9, 26, 23, 1)), 'over');
  assert.equal(serviceMinutesLeft(svc, new Date(2026, 9, 26, 22, 52)), 8);
  assert.equal(serviceStatus({ ...svc, hours: 0 }), 'idle');
  // 시작 시각 수정
  const moved = setServiceStart(s, 'a', new Date(2026, 9, 26, 21, 30).toISOString());
  assert.equal(new Date(serviceEndAt(moved.services[0])).getMinutes(), 30);
});

test('시각만 바꾸기: 자정을 넘는 영업 보정', () => {
  const at = (d, h, m) => new Date(2026, 9, d, h, m).toISOString();
  assert.equal(withTimeOfDay(at(26, 21, 0), '21:40'), at(26, 21, 40));
  // 00:10에 등록했지만 실제 시작은 전날 23:50
  assert.equal(withTimeOfDay(at(27, 0, 10), '23:50'), at(26, 23, 50));
  // 23:50에 등록했는데 실제 시작이 다음날 00:20
  assert.equal(withTimeOfDay(at(26, 23, 50), '00:20'), at(27, 0, 20));
  assert.equal(withTimeOfDay(at(26, 21, 0), 'abc'), at(26, 21, 0));
});

test('카드는 판매액 × 1.1 − 할인, 현금은 판매액 − 할인', () => {
  assert.deepEqual(calcPayment(100000, 'card', 10000), {
    base: 100000, surcharge: 10000, discount: 10000, amount: 100000,
  });
  assert.deepEqual(calcPayment(100000, 'cash', 10000), {
    base: 100000, surcharge: 0, discount: 10000, amount: 90000,
  });
});

test('카드 가산액은 원 단위로 반올림한다', () => {
  assert.equal(calcPayment(12345, 'card', 0).surcharge, 1235);
  assert.equal(calcPayment(12344, 'card', 0).surcharge, 1234);
});

test('할인은 0 이상 정수이고 할인 전 금액을 넘을 수 없다', () => {
  assert.throws(() => calcPayment(10000, 'cash', 10001), /할인 금액이 결제 금액/);
  assert.equal(calcPayment(10000, 'card', 11000).amount, 0);
  assert.throws(() => calcPayment(10000, 'card', 11001), /할인 금액이 결제 금액/);
  assert.throws(() => calcPayment(10000, 'cash', -1), /0 이상/);
  assert.throws(() => calcPayment(10000, 'cash', Number.NaN), /0 이상/);
  assert.throws(() => calcPayment(10000, 'cash', 1.5), /0 이상/);
  assert.throws(() => calcPayment(10000, 'point', 0), /결제수단/);
});

test('결제한 수량 아래로는 줄일 수 없다', () => {
  let s = changeCount(emptySession(), 'beer', 2);
  s = markSessionPaid(s);
  assert.equal(changeCount(s, 'beer', -1), s);
  s = changeCount(s, 'beer', 1);
  assert.equal(changeCount(s, 'beer', -1).quantities.beer, 2);
  assert.equal(changeCount(emptySession(), HOURS_KEY, -1).hours, 0);
});

test('일 마감 집계: 룸별, 구성별, 결제수단별, 품목별', () => {
  const room2 = { id: 'room2', name: '2번 룸', hourlyRate: 40000 };
  const p1 = {
    roomId: 'room1', roomName: '1번 룸', method: 'cash', base: 76000, surcharge: 0, discount: 0, amount: 76000,
    lines: [
      { kind: 'room', name: '1번 룸 이용(시간)', unitPrice: 30000, qty: 2, subtotal: 60000 },
      { kind: 'liquor', name: '맥주', unitPrice: 8000, qty: 2, subtotal: 16000 },
    ],
  };
  const p2 = {
    roomId: room2.id, roomName: room2.name, method: 'card', base: 65000, surcharge: 6500, discount: 1500, amount: 70000,
    lines: [
      { kind: 'room', name: '2번 룸 이용(시간)', unitPrice: 40000, qty: 1, subtotal: 40000 },
      { kind: 'service', name: '과일안주', unitPrice: 25000, qty: 1, subtotal: 25000 },
    ],
  };
  const s = summarizeDay([p2, p1]);
  assert.equal(s.grossSales, 141000);
  assert.equal(s.cardSurchargeTotal, 6500);
  assert.equal(s.discountTotal, 1500);
  assert.equal(s.netTotal, 146000);
  assert.equal(s.cashTotal, 76000);
  assert.equal(s.cardTotal, 70000);
  assert.equal(s.paymentCount, 2);
  assert.deepEqual(s.byCategory, { room: 100000, liquor: 16000, service: 25000 });
  assert.deepEqual(s.byRoom.map((r) => [r.roomId, r.net, r.count]), [['room1', 76000, 1], ['room2', 70000, 1]]);
  assert.equal(s.byItem[0].name, '룸 이용');
  assert.equal(s.byItem.length, 4);
});

test('빈 영업일 집계는 0', () => {
  const s = summarizeDay([]);
  assert.equal(s.netTotal, 0);
  assert.deepEqual(s.byRoom, []);
});

test('영업일 날짜: 영업 시작 시각 기준, 기준 시각 이전이면 전날', () => {
  assert.equal(businessDate(new Date(2026, 9, 26, 23, 30), 0), '2026-10-26');
  assert.equal(businessDate(new Date(2026, 9, 27, 0, 10), 0), '2026-10-27');
  assert.equal(businessDate(new Date(2026, 9, 27, 3, 0), 6), '2026-10-26');
  assert.equal(businessDate(new Date(2026, 9, 1, 3, 0), 6), '2026-09-30');
});

test('영업일 규칙(기준 12시): 20시 ~ 다음날 정오 전 영업은 시작한 날 매출', () => {
  const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).toISOString();
  const close = (openedAt, closedAt) =>
    buildCloseRecord({ id: 'c', openedAt, closedAt, cutoffHour: 12, payments: [] }).business_date;
  assert.equal(close(at(26, 20), at(27, 0, 40)), '2026-10-26');
  assert.equal(close(at(26, 20), at(27, 11, 30)), '2026-10-26');
  // 자정 이후 첫 손님, 자정 이후 결제 없이 마감
  assert.equal(close(at(27, 0, 10), at(27, 1, 30)), '2026-10-26');
  assert.equal(close(null, at(27, 0, 5)), '2026-10-26');
  // 정오 이후는 그날 영업
  assert.equal(close(at(27, 19, 50), at(28, 0, 30)), '2026-10-27');
});

test('마감을 빠뜨린 지난 영업일 감지', () => {
  const opened = new Date(2026, 9, 26, 20, 0);
  assert.equal(isStaleBusinessDay(opened, new Date(2026, 9, 27, 2, 0), 12), false);
  assert.equal(isStaleBusinessDay(opened, new Date(2026, 9, 27, 11, 59), 12), false);
  assert.equal(isStaleBusinessDay(opened, new Date(2026, 9, 27, 12, 0), 12), true);
  assert.equal(isStaleBusinessDay(null, new Date(2026, 9, 28), 12), false);
});

test('마감 기록은 자정을 넘긴 결제도 영업 시작일로 묶는다', () => {
  const openedAt = new Date(2026, 9, 26, 19, 0).toISOString();
  const closedAt = new Date(2026, 9, 27, 2, 30).toISOString();
  const rec = buildCloseRecord({ id: 'c1', openedAt, closedAt, closedBy: '관리자A', cutoffHour: 0, payments: [] });
  assert.equal(rec.business_date, '2026-10-26');
  assert.equal(rec.net_total, 0);
  assert.equal(rec.closed_by, '관리자A');
  const noOpen = buildCloseRecord({ id: 'c2', openedAt: null, closedAt, cutoffHour: 0, payments: [] });
  assert.equal(noOpen.business_date, '2026-10-27');
});
