// 금액 계산 규칙. 모든 금액은 원(KRW) 단위 정수다.
// 화면·저장과 분리된 순수 함수만 둔다(tests/calc.test.js로 고정).

export const CARD_SURCHARGE_PERCENT = 10;

// 분류 키(liquor/service)는 저장 데이터와 호환을 위해 그대로 두고, 화면 이름만 바꾼다.
// liquor = 수량으로 세는 식음료, service = 1인 단위 시간제 서비스
export const CATEGORY_LABELS = {
  room: '룸 이용',
  liquor: '식음료',
  service: '기타 서비스',
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
// 시간제 서비스는 1인 1건이며 금액 = 시간당 단가 × 시간.
export function unpaidLines(session, room, items) {
  const lines = [];
  const hours = session.hours - session.paidHours;
  if (hours > 0) {
    lines.push(makeLine('room', null, `${room.name} 이용(시간)`, room.hourlyRate, hours));
  }
  for (const item of items) {
    const qty = (session.quantities[item.id] || 0) - (session.paidQuantities[item.id] || 0);
    if (qty > 0) lines.push(makeLine(item.category, item.id, item.name, item.price, qty));
  }
  for (const svc of session.services || []) {
    const item = items.find((i) => i.id === svc.itemId);
    const unpaid = svc.hours - svc.paidHours;
    if (item && unpaid > 0) {
      lines.push({ ...makeLine('service', item.id, item.name, item.price, unpaid), serviceId: svc.id, startedAt: svc.startedAt });
    }
  }
  return lines;
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

export function addService(session, itemId, startedAt, id) {
  const svc = { id, itemId, startedAt, hours: 1, paidHours: 0 };
  return { ...session, services: [...(session.services || []), svc] };
}

// 결제한 시간 아래로는 줄일 수 없다.
export function changeServiceHours(session, serviceId, delta) {
  const svc = (session.services || []).find((s) => s.id === serviceId);
  if (!svc) return session;
  const next = svc.hours + delta;
  if (next < svc.paidHours || next < 0) return session;
  return { ...session, services: session.services.map((s) => (s.id === serviceId ? { ...s, hours: next } : s)) };
}

// 결제 기록이 없는 서비스만 지울 수 있다.
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

// 결제가 끝나면 현재 수량까지를 결제 완료로 표시한다.
export function markSessionPaid(session) {
  return {
    ...session,
    paidHours: session.hours,
    paidQuantities: { ...session.quantities },
    services: (session.services || []).map((s) => ({ ...s, paidHours: s.hours })),
  };
}

// 결제한 수량 아래로는 줄일 수 없다(환불은 범위 밖).
export function changeCount(session, key, delta) {
  const isHours = key === HOURS_KEY;
  const current = isHours ? session.hours : session.quantities[key] || 0;
  const paid = isHours ? session.paidHours : session.paidQuantities[key] || 0;
  const next = current + delta;
  if (next < paid || next < 0) return session;
  if (isHours) return { ...session, hours: next };
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
export function buildCloseRecord({ id, openedAt, closedAt, closedBy, cutoffHour, payments }) {
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
    by_category: s.byCategory,
    by_item: s.byItem,
    payments,
  };
}
