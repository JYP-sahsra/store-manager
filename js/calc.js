// 금액 계산 규칙. 모든 금액은 원(KRW) 단위 정수다.
// 화면·저장과 분리된 순수 함수만 둔다(tests/calc.test.js로 고정).

export const CARD_SURCHARGE_PERCENT = 10;

// 분류 키(liquor/service)는 저장 데이터와 호환을 위해 그대로 두고, 화면 이름만 바꾼다.
// liquor = 수량으로 세는 식음료, service = 1인 단위 시간제 서비스
export const CATEGORY_LABELS = {
  room: '룸 이용',
  liquor: '식음료',
  service: '기타 서비스',
  set: '세트',
};

// 시간제 서비스 종료 예정 시각이 이만큼 남으면 '곧 종료'로 강조한다.
export const ENDING_SOON_MINUTES = 10;
const HOUR_MS = 60 * 60 * 1000;

export const METHOD_LABELS = { cash: '현금', card: '카드' };

// 룸 이용 시간 카운터를 품목 카운터와 구분하는 키
export const HOURS_KEY = '__hours';

function makeLine(kind, itemId, name, unitPrice, qty) {
  return { kind, itemId, name, unitPrice, qty, subtotal: unitPrice * qty };
}

// 직전 결제 이후 아직 결제하지 않은 수량·시간만 결제 대상 줄로 만든다.
// 시간제 서비스는 1인 1건이며 금액 = 시간당 단가 × 시간. 종료 시각을 넘긴 서비스는 초과분(1시간 단위 올림)을
// 자동으로 포함한다(overtimeHours). 결제하면 markSessionPaid가 서비스 시간을 그만큼 늘려 확정한다.
export function unpaidLines(session, room, items, now = new Date()) {
  const lines = [];
  const hours = roomHoursTotal(session, now) - session.paidHours;
  if (hours > 0) {
    lines.push(makeLine('room', null, `${room.name} 이용(시간)`, room.hourlyRate, hours));
  }
  for (const item of items) {
    const qty = (session.quantities[item.id] || 0) - (session.paidQuantities[item.id] || 0);
    if (qty > 0) lines.push(makeLine(item.category, item.id, item.name, item.price, qty));
  }
  // 세트 1건 = 세트 가격 1줄(매출 분류는 식음료). 구성 음료는 청구하지 않고 이름만 붙인다.
  for (const o of session.setOrders || []) {
    const set = items.find((i) => i.id === o.setId);
    if (o.paid || !set) continue;
    lines.push({
      ...makeLine('liquor', set.id, set.name, set.price, 1),
      setOrderId: o.id,
      components: o.picks.map((id) => items.find((i) => i.id === id)?.name || '삭제된 품목'),
    });
  }
  for (const svc of session.services || []) {
    const item = items.find((i) => i.id === svc.itemId);
    const overtime = overtimeHours(svc, now);
    const unpaid = svc.hours + overtime - svc.paidHours;
    if (item && unpaid > 0) {
      lines.push({
        ...makeLine('service', item.id, item.name, item.price, unpaid),
        serviceId: svc.id,
        startedAt: svc.startedAt,
        overtimeHours: overtime,
      });
    }
  }
  return lines;
}

// ── 룸 이용 시간 ──
// 룸 시간 = 서비스 연동 시간 + 추가 이용 시간(session.hours, 관리자가 −/+).
// 서비스 연동 시간 = 첫 서비스 시작 ~ 마지막 서비스 종료(초과분 포함)를 1시간 단위로 올림. 서비스가 없으면 0.
export function serviceSpanHours(session, now = new Date()) {
  const live = (session.services || []).filter((s) => s.hours > 0);
  if (!live.length) return 0;
  const start = Math.min(...live.map((s) => new Date(s.startedAt).getTime()));
  const end = Math.max(...live.map((s) => new Date(s.startedAt).getTime() + (s.hours + overtimeHours(s, now)) * HOUR_MS));
  return Math.ceil((end - start) / HOUR_MS);
}

export function roomHoursTotal(session, now = new Date()) {
  return serviceSpanHours(session, now) + session.hours;
}

// 종료 시각을 넘긴 서비스의 초과 시간(1시간 단위 올림). 초과가 아니면 0.
export function overtimeHours(svc, now = new Date()) {
  if (serviceStatus(svc, now) !== 'over') return 0;
  return Math.max(1, Math.ceil(-serviceMinutesLeft(svc, now) / 60));
}

// ── 시간제 서비스 ──

export function serviceEndAt(svc) {
  return new Date(new Date(svc.startedAt).getTime() + svc.hours * HOUR_MS).toISOString();
}

// 'idle'(0시간) | 'running' | 'ending'(종료 10분 이내) | 'over'(종료 시각 지남)
export function serviceStatus(svc, now = new Date()) {
  if (svc.hours <= 0) return 'idle';
  const left = new Date(serviceEndAt(svc)).getTime() - new Date(now).getTime();
  if (left <= 0) return 'over';
  if (left <= ENDING_SOON_MINUTES * 60 * 1000) return 'ending';
  return 'running';
}

// 남은 분(지나면 음수)
export function serviceMinutesLeft(svc, now = new Date()) {
  return Math.ceil((new Date(serviceEndAt(svc)).getTime() - new Date(now).getTime()) / 60000);
}

// 미결제에 자동 포함된 초과 금액(표시용). 시간은 1시간 단위라 초과 분을 올림해 시간당 단가를 곱한다.
// 예: 시간당 40,000원 서비스가 10분 초과 → 1시간 → 40,000원, 70분 초과 → 2시간 → 80,000원
export function overtimeCharge(services, items, now = new Date()) {
  return services.reduce((sum, svc) => {
    const item = items.find((i) => i.id === svc.itemId);
    return sum + (item ? item.price * overtimeHours(svc, now) : 0);
  }, 0);
}

// 서비스 시작 후 지난 분
export function serviceElapsedMinutes(svc, now = new Date()) {
  return Math.max(0, Math.floor((new Date(now).getTime() - new Date(svc.startedAt).getTime()) / 60000));
}

// 서비스를 추가할 때 방문 인원이 모자라면 함께 늘린다(서비스 1건 = 방문 고객 1명).
export function addService(session, itemId, startedAt, id) {
  const svc = { id, itemId, startedAt, hours: 1, paidHours: 0 };
  const services = [...(session.services || []), svc];
  const guests = Math.max(session.guests || 0, services.length + (session.declined || 0));
  return { ...session, services, guests };
}

// ── 방문 인원 ──
// 방문 인원 = 서비스 적용 + 이용안함(이탈) + 대기. 금액에는 영향이 없고 운영 현황용이다.

export function guestSummary(session) {
  const applied = (session.services || []).length;
  const declined = session.declined || 0;
  // 방문 인원을 입력하기 전에 서비스부터 넣은 룸(예전 데이터 포함)은 적용 + 이용안함 인원으로 본다.
  const guests = Math.max(session.guests || 0, applied + declined);
  const waiting = guests - applied - declined;
  let status;
  if (!guests && !applied) status = 'none';
  else if (waiting && !applied) status = 'waiting';
  else if (waiting) status = 'partial';
  else if (applied) status = 'all';
  else status = 'declined';
  return { guests, applied, declined, waiting, status };
}

// 룸 전체 상태. 룸 운영의 핵심은 시간제 서비스이므로 서비스 시간 상태를 결제보다 먼저 본다.
// 우선순위: 초과(추가 결제 필요) > 미결제(결제 필요) > 종료 임박(확인 필요) > 주문 전 > 서비스 대기 > 정상 진행중
export function roomStatus({ balance, paid, guest, serviceStates }) {
  if (serviceStates.includes('over')) return 'over';
  if (balance > 0) return 'due';
  if (serviceStates.includes('ending')) return 'check';
  if (!paid) return 'fresh';
  if (guest.waiting > 0) return 'waiting';
  return 'normal';
}

// 방문 인원은 서비스 적용 + 이용안함 인원보다 적어질 수 없다.
export function changeGuests(session, delta) {
  const { guests, applied, declined } = guestSummary(session);
  const next = guests + delta;
  if (next < applied + declined) return session;
  return { ...session, guests: next };
}

// 이용안함은 대기 인원 안에서만 늘릴 수 있다.
export function changeDeclined(session, delta) {
  const { waiting } = guestSummary(session);
  const next = (session.declined || 0) + delta;
  if (next < 0 || (delta > 0 && waiting < delta)) return session;
  return { ...session, declined: next };
}

// 결제한 시간 아래로는 줄일 수 없다.
export function changeServiceHours(session, serviceId, delta) {
  const svc = (session.services || []).find((s) => s.id === serviceId);
  if (!svc) return session;
  const next = svc.hours + delta;
  if (next < svc.paidHours || next < 0) return session;
  return { ...session, services: session.services.map((s) => (s.id === serviceId ? { ...s, hours: next } : s)) };
}

// 결제 기록이 없는 서비스만 지울 수 있다(시간이 남아 있어도 결제 전이면 삭제 가능 — 잘못 추가한 경우).
export function removeService(session, serviceId) {
  const svc = (session.services || []).find((s) => s.id === serviceId);
  if (!svc || svc.paidHours > 0) return session;
  return { ...session, services: session.services.filter((s) => s.id !== serviceId) };
}

export function setServiceStart(session, serviceId, startedAt) {
  return { ...session, services: (session.services || []).map((s) => (s.id === serviceId ? { ...s, startedAt } : s)) };
}

// 'HH:MM'으로 시각만 바꾼다. 자정을 넘는 영업을 고려해 원래 시각과 12시간 넘게 벌어지면 하루를 옮긴다.
export function withTimeOfDay(iso, hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return iso;
  const base = new Date(iso);
  const next = new Date(base);
  next.setHours(Number(m[1]), Number(m[2]), 0, 0);
  const diff = next.getTime() - base.getTime();
  if (diff > 12 * HOUR_MS) next.setDate(next.getDate() - 1);
  if (diff < -12 * HOUR_MS) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

export function sumLines(lines) {
  return lines.reduce((sum, line) => sum + line.subtotal, 0);
}

// 현금: 판매액 − 할인 / 카드: 판매액 + 10% 가산 − 할인
export function calcPayment(base, method, discount) {
  if (!Number.isInteger(base) || base < 0) {
    throw new Error('판매액이 올바르지 않습니다.');
  }
  if (method !== 'cash' && method !== 'card') {
    throw new Error('결제수단은 현금 또는 카드여야 합니다.');
  }
  if (!Number.isInteger(discount) || discount < 0) {
    throw new Error('할인 금액은 0 이상의 숫자(원)로 입력해 주세요.');
  }
  // base * 10 / 100으로 계산해 0.1 부동소수 오차를 피한다.
  const surcharge = method === 'card' ? Math.round((base * CARD_SURCHARGE_PERCENT) / 100) : 0;
  const beforeDiscount = base + surcharge;
  if (discount > beforeDiscount) {
    throw new Error(`할인 금액이 결제 금액(${beforeDiscount.toLocaleString('ko-KR')}원)보다 큽니다.`);
  }
  return { base, surcharge, discount, amount: beforeDiscount - discount };
}

// ── 외상 ──
// 외상분은 현금 기준(카드 가산 없음)으로 판매액에서 먼저 빼고, 남은 금액에만 결제수단 가산과 할인을 적용한다.
// 매출은 갚은 날 잡는다: 결제 기록의 base는 외상을 뺀 금액, coveredBase는 외상 포함 판매액.
export function calcPaymentWithCredit(base, method, discount, credit) {
  if (!Number.isInteger(credit) || credit < 0) throw new Error('외상 금액은 0 이상의 숫자(원)로 입력해 주세요.');
  if (credit > base) throw new Error(`외상 금액이 판매액(${base.toLocaleString('ko-KR')}원)보다 큽니다.`);
  const r = calcPayment(base - credit, method, discount);
  return { ...r, credit, coveredBase: base };
}

// 전화번호는 숫자만 비교·저장한다(하이픈·공백 무시).
export function normalizePhone(text) {
  return String(text ?? '').replace(/\D/g, '');
}

export function formatPhone(digits) {
  const d = normalizePhone(digits);
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}

// 외상 상환: 장부에서는 상환액만 차감하고, 카드면 상환액 × 1.1을 받는다.
export function calcRepayment(amount, method, balance) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('상환 금액을 1원 이상 입력해 주세요.');
  if (amount > balance) throw new Error(`상환 금액이 외상 잔액(${balance.toLocaleString('ko-KR')}원)보다 큽니다.`);
  return calcPayment(amount, method, 0);
}

// 더치페이: 1인 금액은 100원 단위로 올린다. 모은 돈이 결제 금액보다 많아지는 차액(extra)을 함께 돌려준다.
export function splitBill(amount, people) {
  const n = Math.max(1, Math.floor(people) || 1);
  const perPerson = Math.ceil(amount / n / 100) * 100;
  return { people: n, perPerson, collected: perPerson * n, extra: perPerson * n - amount };
}

// 결제가 끝나면 현재 수량까지를 결제 완료로 표시한다.
// 초과된 서비스는 결제한 초과분만큼 서비스 시간을 늘려 확정한다(unpaidLines와 같은 now를 넘긴다).
export function markSessionPaid(session, now = new Date()) {
  const paid = {
    ...session,
    paidQuantities: { ...session.quantities },
    services: (session.services || []).map((s) => {
      const hours = s.hours + overtimeHours(s, now);
      return { ...s, hours, paidHours: hours };
    }),
    setOrders: (session.setOrders || []).map((o) => ({ ...o, paid: true })),
  };
  // 룸은 서비스 연동 시간까지 포함한 전체 시간을 결제 완료로 표시한다(서비스를 늘리면 룸 미결제도 다시 생긴다).
  return { ...paid, paidHours: roomHoursTotal(paid, now) };
}

// ── 세트 상품 ──
// 세트 = settings.items 중 category 'set'(price, pickCount, setItemIds). 1건마다 대상 음료 pickCount개를 고른다(같은 음료 중복 가능).

export function addSetOrder(session, set, picks, id) {
  if (picks.length !== set.pickCount || picks.some((p) => !set.setItemIds.includes(p))) return session;
  return { ...session, setOrders: [...(session.setOrders || []), { id, setId: set.id, picks: [...picks], paid: false }] };
}

// 결제하지 않은 마지막 세트 1건을 뺀다(결제한 세트는 줄일 수 없음).
export function removeSetOrder(session, setId) {
  const orders = session.setOrders || [];
  const idx = orders.map((o) => !o.paid && o.setId === setId).lastIndexOf(true);
  if (idx < 0) return session;
  return { ...session, setOrders: orders.filter((_, i) => i !== idx) };
}

export function setOrderCounts(session, setId) {
  const list = (session.setOrders || []).filter((o) => o.setId === setId);
  return { qty: list.length, paid: list.filter((o) => o.paid).length };
}

// 식음료 품목별로 지금까지 나간 수량(결제 여부와 무관, 수량 많은 순). free = 서비스(무료)로 나간 수량
// 세트로 나간 구성 음료도 qty에 더한다.
export function drinkCounts(session, items) {
  const free = session.freeQuantities || {};
  const fromSets = {};
  for (const o of session.setOrders || []) for (const id of o.picks) fromSets[id] = (fromSets[id] || 0) + 1;
  const qty = (i) => (session.quantities[i.id] || 0) + (fromSets[i.id] || 0);
  return items
    .filter((i) => i.category === 'liquor' && (qty(i) > 0 || (free[i.id] || 0) > 0))
    .map((i) => ({ name: i.name, qty: qty(i), free: free[i.id] || 0 }))
    .sort((a, b) => b.qty + b.free - (a.qty + a.free));
}

// ── 서비스(무료) 제공 ──
// 손님에게 무료로 내준 식음료. 금액에는 들어가지 않고(미청구), 수량과 정가 기준 금액을 기록만 한다.

export function changeFreeCount(session, itemId, delta) {
  const free = session.freeQuantities || {};
  const next = (free[itemId] || 0) + delta;
  if (next < 0) return session;
  return { ...session, freeQuantities: { ...free, [itemId]: next } };
}

// 세션에서 무료로 내준 품목(정가는 지금 설정 가격으로 기록)
export function freeItems(session, items) {
  const free = session.freeQuantities || {};
  return items
    .filter((i) => (free[i.id] || 0) > 0)
    .map((i) => ({ itemId: i.id, name: i.name, qty: free[i.id], listPrice: i.price }));
}

// 영업일 동안의 서비스 제공 기록을 품목별로 합친다. value = 정가 기준 금액(매출 아님)
export function summarizeComps(comps) {
  const map = new Map();
  for (const c of comps) {
    for (const it of c.items) {
      const key = `${it.name}|${it.listPrice}`;
      if (!map.has(key)) map.set(key, { kind: 'comp', name: it.name, unitPrice: it.listPrice, qty: 0, sales: 0, value: 0 });
      const e = map.get(key);
      e.qty += it.qty;
      e.value += it.qty * it.listPrice;
    }
  }
  return [...map.values()].sort((a, b) => b.qty - a.qty);
}

// 결제한 수량 아래로는 줄일 수 없다(환불은 범위 밖).
// 룸 추가 이용 시간은 서비스 연동 시간과 합친 전체가 결제한 시간보다 작아지지 않게 한다.
export function changeCount(session, key, delta, now = new Date()) {
  if (key === HOURS_KEY) {
    const next = session.hours + delta;
    if (next < 0 || serviceSpanHours(session, now) + next < session.paidHours) return session;
    return { ...session, hours: next };
  }
  const next = (session.quantities[key] || 0) + delta;
  if (next < (session.paidQuantities[key] || 0) || next < 0) return session;
  return { ...session, quantities: { ...session.quantities, [key]: next } };
}

export function summarizeDay(payments) {
  const summary = {
    grossSales: 0,
    cardSurchargeTotal: 0,
    discountTotal: 0,
    netTotal: 0,
    cashTotal: 0,
    cardTotal: 0,
    paymentCount: payments.length,
    byRoom: [],
    byCategory: { room: 0, liquor: 0, service: 0 },
    byItem: [],
    creditIssued: 0, // 이날 외상으로 돌린 판매액(매출에서 제외)
    creditRepaid: 0, // 이날 회수한 외상(장부 차감액, 매출에 포함)
  };
  const rooms = new Map();
  const items = new Map();
  for (const p of payments) {
    summary.grossSales += p.base;
    summary.cardSurchargeTotal += p.surcharge;
    summary.discountTotal += p.discount;
    summary.netTotal += p.amount;
    if (p.method === 'card') summary.cardTotal += p.amount;
    else summary.cashTotal += p.amount;
    summary.creditIssued += p.credit || 0;
    if (p.type === 'repay') {
      summary.creditRepaid += p.base;
      continue; // 외상 회수는 룸·품목 집계에 넣지 않는다
    }

    if (!rooms.has(p.roomId)) {
      rooms.set(p.roomId, { roomId: p.roomId, roomName: p.roomName, base: 0, net: 0, count: 0 });
    }
    const room = rooms.get(p.roomId);
    room.base += p.base;
    room.net += p.amount;
    room.count += 1;

    for (const line of p.lines) {
      summary.byCategory[line.kind] = (summary.byCategory[line.kind] || 0) + line.subtotal;
      // 룸 시간은 룸마다 이름이 달라 종류별로 묶는다.
      const name = line.kind === 'room' ? CATEGORY_LABELS.room : line.name;
      const key = `${line.kind}|${name}|${line.unitPrice}`;
      if (!items.has(key)) {
        items.set(key, { kind: line.kind, name, unitPrice: line.unitPrice, qty: 0, sales: 0 });
      }
      const item = items.get(key);
      item.qty += line.qty;
      item.sales += line.subtotal;
      // 세트 구성 음료는 매출 0원으로 나간 수량만 기록한다.
      for (const part of line.components || []) {
        const pk = `set_part|${part}`;
        if (!items.has(pk)) items.set(pk, { kind: 'set_part', name: part, unitPrice: 0, qty: 0, sales: 0 });
        items.get(pk).qty += 1;
      }
    }
  }
  summary.byRoom = [...rooms.values()].sort((a, b) => a.roomId.localeCompare(b.roomId));
  summary.byItem = [...items.values()].sort((a, b) => b.sales - a.sales);
  return summary;
}

// 영업일 날짜(YYYY-MM-DD, 기기 현지 시각). 기준 시각 이전이면 전날로 친다.
export function businessDate(value, cutoffHour = 0) {
  const d = new Date(value);
  if (d.getHours() < cutoffHour) d.setDate(d.getDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 열려 있는 영업일이 지금 기준으로 이미 지난 날인지(마감을 빠뜨렸는지)
export function isStaleBusinessDay(openedAt, now, cutoffHour = 0) {
  if (!openedAt) return false;
  return businessDate(openedAt, cutoffHour) < businessDate(now, cutoffHour);
}

// 일 마감 기록. 필드 이름은 DB(day_closes) 컬럼과 같다.
// 서비스(무료) 제공은 금액 합계에 넣지 않고 by_item에 kind 'comp'(sales 0, value = 정가 기준) 항목으로 함께 저장한다.
export function buildCloseRecord({ id, openedAt, closedAt, closedBy, cutoffHour, payments, comps = [] }) {
  const s = summarizeDay(payments);
  return {
    id,
    business_date: businessDate(openedAt || closedAt, cutoffHour),
    opened_at: openedAt || null,
    closed_at: closedAt,
    closed_by: closedBy || null,
    gross_sales: s.grossSales,
    discount_total: s.discountTotal,
    card_surcharge_total: s.cardSurchargeTotal,
    net_total: s.netTotal,
    cash_total: s.cashTotal,
    card_total: s.cardTotal,
    payment_count: s.paymentCount,
    by_room: s.byRoom,
    // 외상 발생·회수 합계도 by_category에 함께 둔다(서버 스키마 변경 없음).
    // 판매액 합계(gross_sales) = room + liquor + service − credit_issued + credit_repaid
    by_category: { ...s.byCategory, credit_issued: s.creditIssued, credit_repaid: s.creditRepaid },
    by_item: [...s.byItem, ...summarizeComps(comps)],
    payments,
  };
}
