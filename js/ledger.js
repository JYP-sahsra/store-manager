// 장부(현금출납) 계산. 화면·저장과 분리된 순수 함수만 둔다(tests/ledger.test.js).
// 날짜는 영업일 'YYYY-MM-DD' 문자열, 금액은 원 단위 정수.
//
// 장부 항목(kind)
//  - expense : 지출(method = cash | card | transfer)
//  - cash_out: 시재 회수(사장님 수령·은행 입금 등, 금고 현금 감소)
//  - cash_in : 시재 보충(금고 현금 증가)
//  - set     : 시재 맞춤(그 영업일 시작 시재를 실제로 세어 본 금액으로 정함)
// 수입은 일 마감 기록(현금·카드 받은 금액)에서 가져온다.

export const LEDGER_KINDS = {
  expense: '지출',
  cash_out: '시재 회수',
  cash_in: '시재 보충',
  set: '시재 맞춤',
};

export const EXPENSE_METHODS = { cash: '현금', card: '카드', transfer: '계좌이체' };

export const DEFAULT_CASH_TARGET = 300000;

const pad = (n) => String(n).padStart(2, '0');

export function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(y, m - 1, d + days);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

// 영업일별 수입(받은 금액 기준). closes = 일 마감 기록 목록, live = 아직 마감하지 않은 영업일 수입 { date, cash, card }
export function incomeByDate(closes, live = null) {
  const map = new Map();
  const add = (date, cash, card) => {
    const e = map.get(date) || { cash: 0, card: 0 };
    map.set(date, { cash: e.cash + cash, card: e.card + card });
  };
  for (const r of closes) add(r.business_date, r.cash_total || 0, r.card_total || 0);
  if (live && (live.cash || live.card)) add(live.date, live.cash, live.card);
  return map;
}

// 하루 장부 흐름
export function dayFlow(entries, income) {
  const f = {
    cashIncome: income?.cash || 0,
    cardIncome: income?.card || 0,
    cashExpense: 0,
    cardExpense: 0,
    transferExpense: 0,
    cashOut: 0,
    cashIn: 0,
  };
  for (const e of entries) {
    if (e.kind === 'expense') {
      if (e.method === 'card') f.cardExpense += e.amount;
      else if (e.method === 'transfer') f.transferExpense += e.amount;
      else f.cashExpense += e.amount;
    } else if (e.kind === 'cash_out') f.cashOut += e.amount;
    else if (e.kind === 'cash_in') f.cashIn += e.amount;
  }
  f.expenseTotal = f.cashExpense + f.cardExpense + f.transferExpense;
  f.incomeTotal = f.cashIncome + f.cardIncome;
  f.profit = f.incomeTotal - f.expenseTotal; // 그날 매출(받은 금액) − 지출
  f.cashNet = f.cashIncome - f.cashExpense - f.cashOut + f.cashIn; // 금고 현금 변화
  return f;
}

// 대상 영업일의 시재. 대상일 이하에서 가장 최근 '시재 맞춤'을 시작점으로 그 뒤 날짜의 현금 흐름을 더한다.
// 시재 맞춤이 없으면 hasStart = false(시작 시재를 먼저 입력해야 함).
export function cashBook(entries, income, target) {
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.business_date)) byDate.set(e.business_date, []);
    byDate.get(e.business_date).push(e);
  }
  const flowOf = (date) => dayFlow(byDate.get(date) || [], income.get(date));
  const sets = entries
    .filter((e) => e.kind === 'set' && e.business_date <= target)
    .sort((a, b) => a.business_date.localeCompare(b.business_date) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const flow = flowOf(target);
  if (!sets.length) return { hasStart: false, flow };
  const anchor = sets[sets.length - 1];
  let start = anchor.amount;
  // 시재 맞춤 날짜부터 대상일 전날까지의 현금 흐름을 더한다(맞춤은 그날 시작 시재).
  const dates = new Set([...byDate.keys(), ...income.keys()]);
  for (const d of [...dates].sort()) {
    if (d >= anchor.business_date && d < target) start += flowOf(d).cashNet;
  }
  return { hasStart: true, setDate: anchor.business_date, start, flow, end: start + flow.cashNet };
}
