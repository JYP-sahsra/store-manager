// 금액 계산 규칙. 모든 금액은 원(KRW) 단위 정수다.
// 화면·저장과 분리된 순수 함수만 둔다(tests/calc.test.js로 고정).

export const CARD_SURCHARGE_PERCENT = 10;

export const CATEGORY_LABELS = {
  room: '룸 이용',
  liquor: '주류',
  service: '기타 서비스',
};

export const METHOD_LABELS = { cash: '현금', card: '카드' };

// 룸 이용 시간 카운터를 품목 카운터와 구분하는 키
export const HOURS_KEY = '__hours';

function makeLine(kind, itemId, name, unitPrice, qty) {
  return { kind, itemId, name, unitPrice, qty, subtotal: unitPrice * qty };
}

// 직전 결제 이후 아직 결제하지 않은 수량만 결제 대상 줄로 만든다.
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
  return lines;
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
  return { ...session, paidHours: session.hours, paidQuantities: { ...session.quantities } };
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
