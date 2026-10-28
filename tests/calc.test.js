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
  serviceElapsedMinutes,
  guestSummary,
  changeGuests,
  changeDeclined,
  roomStatus,
  overtimeCharge,
  overtimeHours,
  drinkCounts,
  splitBill,
  changeFreeCount,
  freeItems,
  summarizeComps,
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
  const T = new Date(2026, 9, 26, 21, 40); // 아직 초과 전인 기준 시각(실행 날짜와 무관하게 고정)
  const lines = unpaidLines(s, room, all, T).filter((l) => l.kind === 'service');
  assert.deepEqual(lines.map((l) => [l.serviceId, l.qty, l.subtotal]), [['a', 2, 80000], ['b', 1, 40000]]);
  assert.ok(lines[0].startedAt);

  // 결제 전에는 시간이 남아 있어도 잘못 추가한 서비스를 지울 수 있다
  const extra = addService(s, 'svc', new Date().toISOString(), 'c');
  assert.deepEqual(removeService(extra, 'c').services.map((v) => v.id), ['a', 'b']);

  s = markSessionPaid(s, T);
  assert.equal(sumLines(unpaidLines(s, room, all, T)), 0);
  assert.equal(changeServiceHours(s, 'b', -1), s); // 결제한 시간 아래로 못 줄임
  assert.equal(removeService(s, 'b'), s); // 결제 기록이 있으면 못 지움
  s = changeServiceHours(s, 'b', 1);
  assert.deepEqual(unpaidLines(s, room, all, T).map((l) => [l.serviceId, l.qty]), [['b', 1]]);
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

test('방문 인원: 적용·이용안함·대기 현황과 상태', () => {
  let s = emptySession();
  assert.equal(guestSummary(s).status, 'none');
  s = changeGuests(s, 4);
  assert.deepEqual(guestSummary(s), { guests: 4, applied: 0, declined: 0, waiting: 4, status: 'waiting' });
  s = addService(s, 'svc', new Date().toISOString(), 'a');
  s = addService(s, 'svc', new Date().toISOString(), 'b');
  s = changeDeclined(s, 1);
  assert.deepEqual(guestSummary(s), { guests: 4, applied: 2, declined: 1, waiting: 1, status: 'partial' });
  s = changeDeclined(s, 1);
  assert.equal(guestSummary(s).status, 'all'); // 대기 0, 서비스 2명 + 이용안함 2명
  assert.equal(changeDeclined(s, 1), s); // 대기 인원이 없으면 이용안함을 늘릴 수 없다
  assert.equal(changeGuests(s, -1), s); // 적용 + 이용안함보다 적게 못 줄인다
});

test('방문 인원이 모자라면 서비스 추가 때 함께 늘고, 전원 이용안함 상태도 구분한다', () => {
  let s = addService(emptySession(), 'svc', new Date().toISOString(), 'a');
  assert.equal(s.guests, 1);
  s = changeGuests(emptySession(), 2);
  s = changeDeclined(changeDeclined(s, 1), 1);
  assert.equal(guestSummary(s).status, 'declined');
  // 방문 인원 없이 서비스만 있는 예전 데이터는 서비스 인원을 방문 인원으로 본다
  const legacy = { ...emptySession(), services: [{ id: 'x' }, { id: 'y' }] };
  assert.deepEqual(guestSummary(legacy), { guests: 2, applied: 2, declined: 0, waiting: 0, status: 'all' });
  assert.equal(changeGuests(legacy, 1).guests, 3);
});

test('룸 상태: 서비스 초과가 가장 우선, 종료 임박은 확인 필요, 결제 완료 + 전원 적용만 정상 진행중', () => {
  const g = (waiting) => ({ waiting });
  const st = (balance, paid, waiting, states) => roomStatus({ balance, paid, guest: g(waiting), serviceStates: states });
  assert.equal(st(0, 100000, 0, ['over', 'running']), 'over'); // 결제를 마쳤어도 초과면 추가 결제 필요
  assert.equal(st(40000, 100000, 0, ['ending']), 'due');
  assert.equal(st(0, 100000, 0, ['ending', 'running']), 'check');
  assert.equal(st(0, 0, 3, []), 'fresh');
  assert.equal(st(0, 100000, 1, ['running']), 'waiting');
  assert.equal(st(0, 100000, 0, ['running', 'running']), 'normal');
});

test('초과 추가 예정 금액: 초과 분을 시간 단위로 올림 × 시간당 단가, 초과 서비스만', () => {
  const svcItems = [{ id: 'svc', price: 40000 }];
  const at = (h, m) => new Date(2026, 9, 26, h, m).toISOString();
  const services = [
    { id: 'a', itemId: 'svc', startedAt: at(21, 0), hours: 1, paidHours: 1 }, // 22:00 종료
    { id: 'b', itemId: 'svc', startedAt: at(20, 0), hours: 1, paidHours: 1 }, // 21:00 종료
    { id: 'c', itemId: 'svc', startedAt: at(22, 0), hours: 1, paidHours: 0 }, // 진행 중
  ];
  const now = new Date(2026, 9, 26, 22, 10);
  // a: 10분 초과 → 1시간, b: 70분 초과 → 2시간
  assert.equal(overtimeCharge(services, svcItems, now), 40000 + 80000);
  assert.equal(overtimeCharge(services, svcItems, new Date(2026, 9, 26, 20, 30)), 0);
});

test('초과분은 미결제에 자동 포함되고, 결제하면 서비스 시간이 늘어 초과가 풀린다', () => {
  const svcItems = [{ id: 'svc', name: '도우미', category: 'service', price: 40000 }];
  const now = new Date(2026, 9, 26, 22, 10);
  let s = addService(emptySession(), 'svc', new Date(2026, 9, 26, 21, 0).toISOString(), 'a');
  // 결제 안 한 1시간 + 10분 초과 → 2시간분 80,000원(초과 1시간 포함)
  const lines = unpaidLines(s, room, svcItems, now);
  assert.deepEqual(lines.map((l) => [l.qty, l.subtotal, l.overtimeHours]), [[2, 80000, 1]]);
  s = markSessionPaid(s, now);
  assert.deepEqual([s.services[0].hours, s.services[0].paidHours], [2, 2]);
  assert.equal(serviceStatus(s.services[0], now), 'running'); // 23:00까지 연장됨
  assert.equal(sumLines(unpaidLines(s, room, svcItems, now)), 0);

  // 결제한 1시간이 70분 초과 → 초과 2시간만 미결제
  let p = markSessionPaid(addService(emptySession(), 'svc', new Date(2026, 9, 26, 20, 0).toISOString(), 'b'), new Date(2026, 9, 26, 20, 30));
  assert.equal(overtimeHours(p.services[0], now), 2);
  assert.equal(sumLines(unpaidLines(p, room, svcItems, now)), 80000);
});

test('식음료 나간 수량(결제 여부와 무관, 많은 순)', () => {
  let s = changeCount(changeCount(changeCount(emptySession(), 'beer', 1), 'beer', 1), 'fruit', 1);
  s = markSessionPaid(s);
  s = changeCount(s, 'beer', 1);
  const list = [...items, { id: 'soju', name: '소주', category: 'liquor', price: 6000 }];
  assert.deepEqual(drinkCounts(changeCount(s, 'soju', 1), list), [{ name: '맥주', qty: 3, free: 0 }, { name: '소주', qty: 1, free: 0 }]);
});

test('더치페이: 1인 금액 100원 단위 올림, 차액 표시', () => {
  assert.deepEqual(splitBill(100000, 3), { people: 3, perPerson: 33400, collected: 100200, extra: 200 });
  assert.deepEqual(splitBill(90000, 3), { people: 3, perPerson: 30000, collected: 90000, extra: 0 });
  assert.equal(splitBill(50000, 0).people, 1);
  assert.equal(splitBill(0, 4).perPerson, 0);
});

test('서비스(무료) 제공: 청구하지 않고 수량·정가 기준 금액만 기록', () => {
  let s = changeCount(emptySession(), 'beer', 2);
  s = changeFreeCount(changeFreeCount(s, 'beer', 1), 'fruit', 1);
  assert.equal(changeFreeCount(emptySession(), 'beer', -1).freeQuantities, undefined); // 0 아래로 못 줄임
  // 결제 대상에는 유료 2병만
  assert.equal(sumLines(unpaidLines(s, room, items)), 16000);
  assert.deepEqual(freeItems(s, items).map((i) => [i.name, i.qty, i.listPrice]), [['맥주', 1, 8000], ['과일안주', 1, 25000]]);
  assert.deepEqual(drinkCounts(s, items), [{ name: '맥주', qty: 2, free: 1 }]);
  // 마감 기록: 금액 합계는 그대로, by_item에 comp 항목
  const comps = [{ items: freeItems(s, items) }, { items: [{ name: '맥주', qty: 2, listPrice: 8000 }] }];
  assert.deepEqual(summarizeComps(comps).map((c) => [c.name, c.qty, c.value, c.sales]), [['맥주', 3, 24000, 0], ['과일안주', 1, 25000, 0]]);
  const rec = buildCloseRecord({ id: 'c', openedAt: null, closedAt: new Date().toISOString(), cutoffHour: 12, payments: [], comps });
  assert.equal(rec.net_total, 0);
  assert.equal(rec.by_item.filter((i) => i.kind === 'comp').length, 2);
});

test('서비스 경과 시간(분)', () => {
  const svc = { startedAt: new Date(2026, 9, 26, 21, 0).toISOString(), hours: 1 };
  assert.equal(serviceElapsedMinutes(svc, new Date(2026, 9, 26, 21, 35)), 35);
  assert.equal(serviceElapsedMinutes(svc, new Date(2026, 9, 26, 20, 50)), 0);
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
