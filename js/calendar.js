// 매출 월 캘린더 계산. 화면과 분리된 순수 함수만 둔다(tests/calendar.test.js).
// 월은 'YYYY-MM', 날짜는 'YYYY-MM-DD'(영업일 business_date와 같은 형식) 문자열이다.

const pad = (n) => String(n).padStart(2, '0');

export function monthOf(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}/.test(value)) return value.slice(0, 7);
  const d = new Date(value);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  return monthOf(new Date(y, m - 1 + delta, 1));
}

export function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${pad(days)}`, days };
}

// 일요일 시작 7열 달력 칸. 1일 앞과 말일 뒤의 빈칸은 null.
export function calendarCells(month) {
  const [y, m] = month.split('-').map(Number);
  const cells = Array(new Date(y, m - 1, 1).getDay()).fill(null);
  const { days } = monthRange(month);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${pad(d)}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

// 같은 영업일에 마감이 여러 번 있으면 합친다. creditIssued/creditRepaid = 그날 외상 발생·회수 합계
export function closesByDate(closes) {
  const map = new Map();
  for (const r of closes) {
    if (!map.has(r.business_date)) {
      map.set(r.business_date, { date: r.business_date, net: 0, count: 0, creditIssued: 0, creditRepaid: 0, closes: [] });
    }
    const e = map.get(r.business_date);
    e.net += r.net_total;
    e.count += r.payment_count;
    e.creditIssued += r.by_category?.credit_issued || 0;
    e.creditRepaid += r.by_category?.credit_repaid || 0;
    e.closes.push(r);
  }
  return map;
}

// 달력 칸에 들어갈 짧은 금액(만원 단위). 96,600 → 9.7만, 1,234,000 → 123만
export function compactWon(n) {
  if (!n) return '0';
  const man = n / 10000;
  return man >= 100 ? `${Math.round(man)}만` : `${Math.round(man * 10) / 10}만`;
}
