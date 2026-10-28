// 화면 렌더링과 이벤트 처리. 계산은 calc.js, 저장은 storage.js, 서버는 api.js가 담당한다.
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
  addService,
  changeServiceHours,
  removeService,
  setServiceStart,
  serviceEndAt,
  serviceStatus,
  serviceMinutesLeft,
  serviceElapsedMinutes,
  withTimeOfDay,
  guestSummary,
  changeGuests,
  roomStatus,
  calcPaymentWithCredit,
  calcRepayment,
  normalizePhone,
  formatPhone,
  overtimeCharge,
  overtimeHours,
  drinkCounts,
  splitBill,
  changeFreeCount,
  freeItems,
  CATEGORY_LABELS,
  METHOD_LABELS,
  HOURS_KEY,
  CARD_SURCHARGE_PERCENT,
} from './calc.js';
import {
  loadState,
  saveState,
  newId,
  exportBackup,
  parseBackup,
  validateSettings,
  mergeServerSettings,
  addCloseHistory,
  SETTINGS_VERSION,
} from './storage.js';
import * as api from './api.js';
import { monthOf, shiftMonth, monthRange, calendarCells, closesByDate, compactWon } from './calendar.js';

const app = document.getElementById('app');
const loaded = loadState(localStorage);
let state = loaded.state;

const ui = {
  tab: 'rooms',
  roomId: null, // 상세를 보고 있는 룸
  category: 'liquor', // 룸 화면에서 보고 있는 메뉴 분류
  payment: null, // { roomId, method, discountText, endAfter }
  draft: null, // 설정 화면 편집 중인 값
  notice: loaded.warning,
  // 매출 캘린더: data = { source: 'server' | 'local', list }, selected = 펼친 날짜
  calendar: { month: monthOf(new Date()), data: null, loading: false, selected: null },
  // 접고 펴는 영역의 펼침 상태(다시 그려도 유지). 기본 정보는 PIN이 없을 때만 처음부터 펼친다.
  folds: { basic: !state.pin, rooms: false, items: false, calc: false, credit: false },
  // 간이 계산기(매출에 기록하지 않음): 품목별 수량, 결제수단, 더치페이 인원
  calc: { counts: {}, method: 'cash', people: 1 },
  // 외상 장부: accounts = 서버 명단(null이면 아직 안 불러옴), detail = 선택한 사람의 하위 내역
  credit: { accounts: null, loading: false, error: '', query: '', detail: null, repayText: '', repayMethod: 'cash' },
  appVersion: '', // 실행 중인 앱 버전(service worker 캐시 이름)
  updateReady: false, // 새 버전이 준비됐지만 입력 중이라 적용을 미뤘다
  busy: false,
};

const TABS = [
  { id: 'rooms', label: '룸' },
  { id: 'sales', label: '매출' },
  { id: 'settings', label: '관리' },
];

// ── 공통 ─────────────────────────────────────────────

const won = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// 시각 입력칸(type=time)이 오전/오후로 보이므로 서비스 종료 예정도 같은 형식으로 맞춘다.
const fmtTime12 = (iso) => {
  const d = new Date(iso);
  const h = d.getHours();
  return `${h < 12 ? '오전' : '오후'} ${pad(h % 12 || 12)}:${pad(d.getMinutes())}`;
};
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(iso)}`;
};
function leftText(minutes) {
  if (minutes <= 0) return `${-minutes}분 초과`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 남음` : `${minutes}분 남음`;
}
const clock = (minutes) => `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;

// 방문 인원 현황(guestSummary.status) 화면 이름
const GUEST_STATUS_LABELS = {
  none: '인원 미입력',
  waiting: '서비스 대기중',
  partial: '일부 이용중',
  all: '전원 적용중',
  declined: '서비스 이용안함',
};

// '12,000' 같은 입력을 정수로. 빈 값은 emptyValue, 숫자가 아니면 NaN.
function parseWon(text, emptyValue = 0) {
  const t = String(text ?? '').replace(/[,\s원]/g, '');
  if (t === '') return emptyValue;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

function commit() {
  try {
    saveState(state, localStorage);
  } catch (e) {
    ui.notice = `휴대폰에 저장하지 못했습니다: ${e.message}. 백업 파일을 내보내 주세요.`;
  }
  render();
}

function notify(message) {
  ui.notice = message;
  render();
}

const roomById = (id) => state.settings.rooms.find((r) => r.id === id);
const activeRooms = () => state.settings.rooms.filter((r) => state.sessions[r.id]);
const sessionPaid = (s) => state.payments.filter((p) => p.sessionId === s.id).reduce((a, p) => a + p.amount, 0);
const balanceOf = (room, s) => sumLines(unpaidLines(s, room, state.settings.items));
const currentBusinessDate = () =>
  businessDate(state.businessDay.openedAt || new Date(), state.settings.dayCutoffHour);
// 마감을 빠뜨린 지난 영업일이면 그 날짜, 아니면 null
const staleBusinessDate = () =>
  isStaleBusinessDay(state.businessDay.openedAt, new Date(), state.settings.dayCutoffHour)
    ? currentBusinessDate()
    : null;
function staleWarning() {
  const date = staleBusinessDate();
  if (!date) return '';
  return `<p class="warn" role="alert">${esc(date)} 영업이 아직 마감되지 않았습니다. 마감 전 결제는 모두 ${esc(date)} 매출로 기록됩니다. 룸을 모두 종료하고 매출 탭에서 마감해 주세요.</p>`;
}

function downloadFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── 화면 ─────────────────────────────────────────────

function render() {
  const views = { rooms: roomsView, sales: salesView, settings: settingsView };
  app.innerHTML = `
    <header class="topbar">
      <h1>${esc(state.settings.storeName || '매장관리')}</h1>
      <span class="muted">${esc(currentBusinessDate())} 영업</span>
      <button class="btn small sync-btn" data-action="sync" ${ui.busy ? 'disabled' : ''} aria-label="최신 앱과 서버 데이터로 동기화">동기화</button>
    </header>
    ${ui.notice ? `<div class="notice" role="status"><span>${esc(ui.notice)}</span>
      <button class="icon-btn" data-action="dismiss-notice" aria-label="알림 닫기">✕</button></div>` : ''}
    <main class="content">${views[ui.tab]()}</main>
    <nav class="tabbar" aria-label="메뉴">
      ${TABS.map((t) => `<button data-action="tab" data-tab="${t.id}" ${ui.tab === t.id ? 'aria-current="page"' : ''}>${t.label}</button>`).join('')}
    </nav>
    ${ui.payment ? paymentSheet() : ''}`;
}

function roomsView() {
  if (ui.roomId && state.sessions[ui.roomId]) return roomDetailView(ui.roomId);
  ui.roomId = null;
  return `${staleWarning()}<div class="room-list">${state.settings.rooms.map(roomCard).join('')}</div>
    ${state.settings.items.length ? calculatorSection() : '<p class="empty">관리 탭에서 판매 품목과 룸 요금을 먼저 입력해 주세요.</p>'}`;
}

// 간이 계산기: 판매 품목 수량을 세어 현금/카드 금액과 더치페이를 계산한다. 매출·룸에는 기록하지 않는다.
function calculatorSection() {
  const c = ui.calc;
  const items = state.settings.items.filter((i) => i.active);
  const base = items.reduce((sum, i) => sum + i.price * (c.counts[i.id] || 0), 0);
  const pay = calcPayment(base, c.method, 0);
  const split = splitBill(pay.amount, c.people);
  const count = Object.values(c.counts).reduce((a, n) => a + n, 0);
  const row = (i) => {
    const qty = c.counts[i.id] || 0;
    return `<div class="calc-row ${qty ? 'picked' : ''}">
      <div class="counter-label"><span>${esc(i.name)}</span><small>${won(i.price)}${i.category === 'service' ? ' · 1시간' : ''}</small></div>
      <div class="counter">
        <button class="step" data-action="calc-count" data-key="${esc(i.id)}" data-delta="-1" ${qty ? '' : 'disabled'} aria-label="${esc(i.name)} 빼기">−</button>
        <span class="qty">${qty}</span>
        <button class="step" data-action="calc-count" data-key="${esc(i.id)}" data-delta="1" aria-label="${esc(i.name)} 더하기">+</button>
      </div>
    </div>`;
  };
  const group = (cat) => {
    const list = items.filter((i) => i.category === cat);
    return list.length ? `<h4>${CATEGORY_LABELS[cat]}</h4>${list.map(row).join('')}` : '';
  };
  return `<details class="card fold calc" data-fold="calc" ${ui.folds.calc ? 'open' : ''}>
    <summary><h3>간이 계산기</h3><span class="muted">${count ? `${count}개 · ${won(pay.amount)}` : '매출에 기록되지 않는 계산용'}</span></summary>
    ${group('liquor')}
    ${group('service')}
    <div class="segmented big calc-method" role="radiogroup" aria-label="계산기 결제수단">
      <button role="radio" aria-checked="${c.method === 'cash'}" data-action="calc-method" data-method="cash">현금<small>판매액 그대로</small></button>
      <button role="radio" aria-checked="${c.method === 'card'}" data-action="calc-method" data-method="card">카드<small>+${CARD_SURCHARGE_PERCENT}% 가산</small></button>
    </div>
    <dl class="sum">
      <div><dt>판매액</dt><dd>${won(pay.base)}</dd></div>
      ${pay.surcharge ? `<div><dt>카드 가산 ${CARD_SURCHARGE_PERCENT}%</dt><dd>+${won(pay.surcharge)}</dd></div>` : ''}
      <div class="grand"><dt>결제 금액</dt><dd>${won(pay.amount)}</dd></div>
    </dl>
    <div class="counter-row split-row">
      <div class="counter-label"><span>더치페이 ${split.people}명</span>
        <small>${split.people > 1 ? `1인 ${won(split.perPerson)} (100원 단위 올림${split.extra ? ` · 합계 +${won(split.extra)}` : ''})` : '인원을 늘리면 1인 금액을 계산합니다'}</small></div>
      <div class="counter">
        <button class="step" data-action="calc-people" data-delta="-1" ${split.people <= 1 ? 'disabled' : ''} aria-label="더치페이 인원 줄이기">−</button>
        <span class="qty">${split.people}</span>
        <button class="step" data-action="calc-people" data-delta="1" aria-label="더치페이 인원 늘리기">+</button>
      </div>
    </div>
    ${split.people > 1 ? `<div class="big-total split-total"><span>1인당</span><b>${won(split.perPerson)}</b></div>` : ''}
    <button class="btn block" data-action="calc-reset">계산기 비우기</button>
  </details>`;
}

// 상태별 타일: 비어 있음(입장 버튼) / 이용 중·미결제(강조) / 이용 중·결제 완료
function roomCard(room) {
  const s = state.sessions[room.id];
  if (!s) {
    return `<div class="room-tile idle">
      <div class="idle-info">
        <h2>${esc(room.name)}</h2>
        <span class="idle-state"><i class="dot" aria-hidden="true"></i>비어 있음</span>
        <span class="muted">시간당 ${won(room.hourlyRate)}</span>
      </div>
      <button class="btn primary enter-btn" data-action="start-room" data-room="${room.id}">손님 입장</button>
    </div>`;
  }
  const balance = balanceOf(room, s);
  const paid = sessionPaid(s);
  const g = guestSummary(s);
  const now = new Date();
  const services = s.services || [];
  const status = roomStatus({ balance, paid, guest: g, serviceStates: services.map((v) => serviceStatus(v, now)) });
  const meta = [
    `입장 <b>${fmtTime12(s.startedAt)}</b>`,
    g.guests ? `방문 <b>${g.guests}명</b>${g.waiting ? ` · <b class="wait">대기 ${g.waiting}</b>` : ''}` : '방문 인원 미입력',
  ].join('<span class="sep">·</span>');
  const extra = overtimeCharge(services, state.settings.items, now); // 미결제에 이미 포함된 초과분
  const drinks = drinkCounts(s, state.settings.items);
  return `<button class="room-tile st-${status}" data-action="open-room" data-room="${room.id}">
    <div class="room-head"><h2>${esc(room.name)}</h2>
      <span class="status-badge st-${status}">${ROOM_STATUS_LABELS[status](g)}</span></div>
    <div class="room-meta">${meta}</div>
    ${services.length ? `<div class="svc-grid">${services.map((v, i) => serviceTimeChip(v, i + 1, now)).join('')}</div>` : ''}
    ${drinks.length ? `<div class="drink-line"><span class="muted">식음료</span>${drinks.map((d) => `<span class="drink">${esc(d.name)}${d.qty ? ` <b>${d.qty}</b>` : ''}${d.free ? ` <span class="free-tag">서비스 ${d.free}</span>` : ''}</span>`).join('')}</div>` : ''}
    <dl class="room-money">
      <div><dt>결제 완료</dt><dd>${won(paid)}</dd></div>
      <div class="${extra ? 'extra' : balance ? 'due' : ''}"><dt>미결제</dt><dd>${won(balance)}</dd>
        ${extra ? `<small>초과 ${won(extra)} 포함</small>` : ''}</div>
    </dl>
  </button>`;
}

// 룸 상태(calc.roomStatus) 라벨
const ROOM_STATUS_LABELS = {
  over: () => '추가 결제 필요',
  due: () => '결제 필요',
  check: () => '확인 필요',
  fresh: () => '주문 전',
  waiting: (g) => `서비스 대기 ${g.waiting}명`,
  normal: () => '정상 진행중',
};

// 서비스 인원별 시간 칩: 번호, 남은/초과 시간(가장 크게), 종료 예정 시각·경과
function serviceTimeChip(svc, no, now) {
  const st = serviceStatus(svc, now);
  const left = serviceMinutesLeft(svc, now);
  const abs = Math.abs(left);
  const amount = abs >= 60 ? clock(abs) : `${abs}분`; // 칩 폭에 맞게 1시간 이상은 1:05처럼 줄인다
  const main = st === 'idle' ? '시간 미정' : `${amount} ${left <= 0 ? '초과' : '남음'}`;
  const sub = svc.hours ? `~${fmtTime12(serviceEndAt(svc))} · ${clock(serviceElapsedMinutes(svc, now))} 경과` : '시간을 정해 주세요';
  return `<div class="svc-time-chip ${st}"><span class="no">${no}번</span><b>${main}</b><small>${sub}</small></div>`;
}

function counterRow({ label, sub, key, qty, paid }) {
  return `<div class="counter-row">
    <div class="counter-label"><span>${esc(label)}</span><small>${esc(sub)}${paid ? ` · 결제 ${paid}` : ''}</small></div>
    <div class="counter">
      <button class="step" data-action="dec" data-key="${esc(key)}" ${qty <= paid ? 'disabled' : ''} aria-label="${esc(label)} 줄이기">−</button>
      <span class="qty" aria-label="${esc(label)} 수량">${qty}</span>
      <button class="step" data-action="inc" data-key="${esc(key)}" aria-label="${esc(label)} 늘리기">+</button>
    </div>
  </div>`;
}

// 셀프 주문형 메뉴 카드. 담긴 수량이 있으면 강조하고, 결제한 수량 아래로는 줄일 수 없다.
// 식음료 카드에는 서비스(무료) 수량 줄을 함께 둔다(청구하지 않고 기록만).
function menuCard(item, s) {
  const qty = s.quantities[item.id] || 0;
  const paid = s.paidQuantities[item.id] || 0;
  const free = (s.freeQuantities || {})[item.id] || 0;
  return `<div class="menu-card ${qty ? 'picked' : ''} ${free ? 'has-free' : ''}">
    <div class="menu-name">${esc(item.name)}</div>
    <div class="menu-price">${won(item.price)}${paid ? ` · 결제 ${paid}` : ''}</div>
    <div class="counter">
      <button class="step" data-action="dec" data-key="${esc(item.id)}" ${qty <= paid ? 'disabled' : ''} aria-label="${esc(item.name)} 빼기">−</button>
      <span class="qty" aria-label="${esc(item.name)} 수량">${qty}</span>
      <button class="step" data-action="inc" data-key="${esc(item.id)}" aria-label="${esc(item.name)} 담기">+</button>
    </div>
    ${item.category === 'liquor' ? `<div class="free-row">
      <span>서비스</span>
      <button class="mini" data-action="free" data-key="${esc(item.id)}" data-delta="-1" ${free ? '' : 'disabled'} aria-label="${esc(item.name)} 서비스 빼기">−</button>
      <b>${free}</b>
      <button class="mini" data-action="free" data-key="${esc(item.id)}" data-delta="1" aria-label="${esc(item.name)} 서비스로 제공">+</button>
    </div>` : ''}
  </div>`;
}

// 시간제 서비스 카드(1명): 시작 시각(수정 가능) → 종료 예정 시각, 남은 시간, 시간 −/+
function serviceCard(svc, no, now) {
  const item = state.settings.items.find((i) => i.id === svc.itemId);
  const status = serviceStatus(svc, now);
  // 잘못 누른 서비스는 결제 전이면 언제든 지울 수 있다(결제한 서비스는 기록 보존을 위해 지우지 않는다).
  const removable = svc.paidHours === 0;
  return `<div class="svc-card ${status}">
    <div class="svc-top">
      <b>${esc(item?.name || '삭제된 서비스')} · ${no}번</b>
      <span class="svc-badge ${status}">${status === 'idle' ? '시간 미정' : leftText(serviceMinutesLeft(svc, now))}</span>
      ${removable ? `<button class="svc-del" data-action="svc-remove" data-id="${esc(svc.id)}" aria-label="${no}번 서비스 삭제">삭제</button>` : ''}
    </div>
    <div class="svc-time">
      <label class="svc-start"><span>시작 · ${clock(serviceElapsedMinutes(svc, now))} 경과</span>
        <input type="time" data-input="svc-start" data-id="${esc(svc.id)}" value="${fmtTime(svc.startedAt)}" aria-label="${no}번 서비스 시작 시각"></label>
      <span class="svc-arrow" aria-hidden="true">→</span>
      <div class="svc-end"><span>종료 예정</span><b>${svc.hours ? fmtTime12(serviceEndAt(svc)) : '–'}</b></div>
    </div>
    <div class="counter-row svc-hours">
      <div class="counter-label"><span>${svc.hours}시간 · ${won((item?.price || 0) * svc.hours)}</span>
        <small>${svc.paidHours ? `결제 ${svc.paidHours}시간` : '미결제'}</small>
        ${overtimeHours(svc, now) ? `<small class="ot">초과 ${overtimeHours(svc, now)}시간(${won((item?.price || 0) * overtimeHours(svc, now))}) 미결제에 포함 · 결제하면 연장</small>` : ''}</div>
      <div class="counter">
        <button class="step" data-action="svc-dec" data-id="${esc(svc.id)}" ${svc.hours <= svc.paidHours ? 'disabled' : ''} aria-label="${no}번 서비스 1시간 줄이기">−</button>
        <span class="qty">${svc.hours}</span>
        <button class="step" data-action="svc-inc" data-id="${esc(svc.id)}" aria-label="${no}번 서비스 1시간 연장">+</button>
      </div>
    </div>
  </div>`;
}

// 방문 인원 관리(대기 = 방문 − 서비스 적용, 금액에는 영향 없음)와 룸 이용안함(손님 이탈 → 룸 비우기)
function guestCard(s) {
  const g = guestSummary(s);
  return `<section class="card guest-card">
    <div class="guest-head"><h3>방문 인원</h3><span class="guest-badge ${g.status}">${GUEST_STATUS_LABELS[g.status]}</span></div>
    <div class="counter-row">
      <div class="counter-label"><span>방문 ${g.guests}명</span>
        <small>서비스 적용 ${g.applied} · 대기 ${g.waiting}</small></div>
      <div class="counter">
        <button class="step" data-action="guests" data-delta="-1" ${g.guests <= g.applied + g.declined ? 'disabled' : ''} aria-label="방문 인원 줄이기">−</button>
        <span class="qty">${g.guests}</span>
        <button class="step" data-action="guests" data-delta="1" aria-label="방문 인원 늘리기">+</button>
      </div>
    </div>
    ${(s.services || []).length
      ? '<p class="muted cancel-note">기타 서비스를 시작한 뒤에는 이용안함(룸 비우기)을 할 수 없습니다. 잘못 추가한 서비스는 서비스 카드에서 삭제해 주세요.</p>'
      : '<button class="btn block cancel-room" data-action="room-cancel">이용안함 · 룸 비우기</button>'}
  </section>`;
}

function serviceSection(s) {
  const now = new Date();
  const svcItems = state.settings.items.filter((i) => i.category === 'service' && i.active);
  const services = s.services || [];
  // 시간제로 바뀌기 전에 수량으로 담은 서비스(시범 운영 데이터)는 수량 카드로 남겨 정산할 수 있게 한다.
  const legacy = state.settings.items.filter((i) => i.category === 'service' && (s.quantities[i.id] || 0) > 0);
  return `
    <div class="svc-add">
      ${svcItems.map((i) => `<button class="svc-add-btn" data-action="svc-add" data-item="${esc(i.id)}">
        <b>+ ${esc(i.name)} 시작</b><small>1명 · 시간당 ${won(i.price)}</small></button>`).join('')
        || '<p class="muted">관리 탭에서 기타 서비스 품목을 추가해 주세요.</p>'}
    </div>
    ${services.length
      ? `<div class="svc-list">${services.map((v, i) => serviceCard(v, i + 1, now)).join('')}</div>`
      : '<p class="muted center">서비스를 시작하면 1명씩 시작·종료 시각과 시간을 관리합니다.</p>'}
    ${legacy.length ? `<div class="menu-grid">${legacy.map((i) => menuCard(i, s)).join('')}</div>` : ''}`;
}

function roomDetailView(roomId) {
  const room = roomById(roomId);
  const s = state.sessions[roomId];
  const items = state.settings.items.filter((i) => i.active || (s.quantities[i.id] || 0) > 0);
  const cats = ['liquor', 'service'].filter(
    (c) => items.some((i) => i.category === c) || (c === 'service' && (s.services || []).length),
  );
  if (!cats.includes(ui.category)) ui.category = cats[0] || 'liquor';
  const unpaid = unpaidLines(s, room, state.settings.items);
  const balance = sumLines(unpaid);
  const now = new Date();
  const liveServices = (s.services || []).filter((v) => v.hours > 0);
  const urgent = liveServices.some((v) => ['ending', 'over'].includes(serviceStatus(v, now)));
  const chipLabel = (c) =>
    c === 'service' && liveServices.length ? `${CATEGORY_LABELS[c]} ${liveServices.length}명` : CATEGORY_LABELS[c];
  return `
    <div class="detail-head">
      <button class="link" data-action="back">‹ 룸 목록</button>
      <div class="row-between"><h2>${esc(room.name)}</h2>
        <span class="entry-time">입장 <b>${fmtTime12(s.startedAt)}</b></span></div>
    </div>
    <section class="card time-card">
      ${counterRow({ label: '룸 이용 시간', sub: `시간당 ${won(room.hourlyRate)}`, key: HOURS_KEY, qty: s.hours, paid: s.paidHours })}
    </section>
    ${guestCard(s)}
    ${cats.length ? `
      <div class="chips" role="tablist" aria-label="메뉴 분류">
        ${cats.map((c) => `<button role="tab" class="chip ${c === 'service' && urgent ? 'urgent' : ''}" aria-selected="${ui.category === c}" data-action="category" data-category="${c}">${chipLabel(c)}</button>`).join('')}
      </div>
      ${ui.category === 'service'
        ? serviceSection(s)
        : `<div class="menu-grid">${items.filter((i) => i.category === 'liquor').map((i) => menuCard(i, s)).join('')}</div>`}`
    : '<p class="empty">판매 중인 품목이 없습니다. 관리 탭에서 추가해 주세요.</p>'}
    <div class="order-bar">
      <div class="order-sum">
        <span>${balance ? `미결제 ${unpaid.length}건` : '미결제 없음'} · 결제 ${won(sessionPaid(s))}</span>
        <b>${won(balance)}</b>
      </div>
      <div class="actions">
        <button class="btn" data-action="end-room">종료</button>
        <button class="btn primary grow" data-action="open-payment" ${balance > 0 ? '' : 'disabled'}>결제하기</button>
      </div>
    </div>`;
}

function paymentSummary(base, method, discountText, creditText = '') {
  let r;
  try {
    r = calcPaymentWithCredit(base, method, parseWon(discountText), parseWon(creditText));
  } catch (e) {
    return `<p class="error" role="alert">${esc(e.message)}</p>`;
  }
  return `<dl class="sum">
    <div><dt>판매액</dt><dd>${won(r.coveredBase)}</dd></div>
    ${r.credit ? `<div class="credit-line"><dt>외상 (나중에 받음)</dt><dd>−${won(r.credit)}</dd></div>` : ''}
    ${method === 'card' ? `<div><dt>카드 가산 ${CARD_SURCHARGE_PERCENT}%</dt><dd>+${won(r.surcharge)}</dd></div>` : ''}
    ${r.discount ? `<div><dt>할인</dt><dd>−${won(r.discount)}</dd></div>` : ''}
    <div class="grand"><dt>받을 금액</dt><dd>${won(r.amount)}</dd></div>
  </dl>`;
}

// 결제 화면의 외상 영역(접힘). 외상이 드물어 기본 결제 흐름에 끼어들지 않게 한다.
function creditFold(base) {
  const p = ui.payment;
  return `<details class="credit-fold" data-fold="pay-credit" ${p.creditOpen ? 'open' : ''}>
    <summary>외상 처리 <span class="muted">(선택 · 일부 또는 전액을 나중에 받기)</span></summary>
    <div class="credit-amount">
      <label class="field"><span>외상 금액(원, 현금 기준)</span>
        <input data-input="credit-amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(p.creditText)}"></label>
      <button class="btn small" data-action="credit-all" data-base="${base}">전액 외상</button>
    </div>
    <div class="grid-2">
      <label class="field"><span>전화번호</span>
        <input data-input="credit-phone" type="tel" inputmode="tel" autocomplete="off" placeholder="010-0000-0000" value="${esc(p.creditPhone)}"></label>
      <label class="field"><span>이름</span>
        <input data-input="credit-name" autocomplete="off" value="${esc(p.creditName)}"></label>
    </div>
    <div id="credit-match">${creditMatch()}</div>
  </details>`;
}

// 입력한 전화번호·이름으로 기존 외상 명단을 찾아 보여 준다(같은 사람 = 같은 전화번호).
function creditMatch() {
  const p = ui.payment;
  const list = ui.credit.accounts;
  if (!list) return `<p class="muted">${ui.credit.loading ? '외상 명단을 불러오는 중…' : esc(ui.credit.error || '')}</p>`;
  const digits = normalizePhone(p.creditPhone);
  const exact = digits && list.find((a) => a.phone === digits);
  if (exact) return `<p class="credit-hit">기존 명단: <b>${esc(exact.name)}</b> · 외상 잔액 ${won(exact.balance)} (이 내역 아래에 추가됩니다)</p>`;
  const q = (p.creditName || '').trim();
  const hits = list.filter((a) => (digits.length >= 3 && a.phone.includes(digits)) || (q && a.name.includes(q))).slice(0, 5);
  if (!hits.length) return digits.length >= 9 ? '<p class="muted">새 외상 명단으로 등록됩니다.</p>' : '';
  return `<div class="credit-hits">${hits.map((a) => `<button class="chip" data-action="credit-pick" data-phone="${esc(a.phone)}" data-name="${esc(a.name)}">
    ${esc(a.name)} ${esc(formatPhone(a.phone))} · ${won(a.balance)}</button>`).join('')}</div>`;
}

function paymentSheet() {
  const { roomId, method, discountText, endAfter, creditText } = ui.payment;
  const room = roomById(roomId);
  const s = state.sessions[roomId];
  const lines = unpaidLines(s, room, state.settings.items);
  const base = sumLines(lines);
  const paid = sessionPaid(s);
  return `<div class="sheet-backdrop">
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pay-title">
      <div class="sheet-grip" aria-hidden="true"></div>
      <h2 id="pay-title">${esc(room.name)} 결제</h2>
      ${paid ? `<p class="muted">앞서 결제한 금액 ${won(paid)} · 아래는 이번에 받을 주문입니다.</p>` : ''}
      ${endAfter ? '<p class="warn">미결제 금액이 있습니다. 결제하면 룸을 종료합니다.</p>' : ''}
      ${freeItems(s, state.settings.items).length ? `<p class="muted">서비스(무료, 청구 안 함): ${freeItems(s, state.settings.items).map((f) => `${esc(f.name)} ${f.qty}`).join(' · ')}</p>` : ''}
      ${linesTable(lines)}
      <div class="segmented big" role="radiogroup" aria-label="결제수단">
        <button role="radio" aria-checked="${method === 'cash'}" data-action="pay-method" data-method="cash">현금<small>판매액 그대로</small></button>
        <button role="radio" aria-checked="${method === 'card'}" data-action="pay-method" data-method="card">카드<small>+${CARD_SURCHARGE_PERCENT}% 가산</small></button>
      </div>
      <label class="field"><span>할인 금액(원)</span>
        <input id="discount" data-input="discount" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(discountText)}">
      </label>
      ${creditFold(base)}
      <div id="pay-summary">${paymentSummary(base, method, discountText, creditText)}</div>
      <div class="actions">
        <button class="btn" data-action="cancel-payment">취소</button>
        <button class="btn primary" id="confirm-payment" data-action="confirm-payment">결제 완료</button>
      </div>
    </div>
  </div>`;
}

function linesTable(lines) {
  return `<table class="lines"><tbody>
    ${lines.map((l) => `<tr>
      <td>${esc(l.name)}${l.startedAt ? ` <small class="muted">${fmtTime(l.startedAt)}~</small>` : ''}${l.overtimeHours ? ` <small class="ot">초과 ${l.overtimeHours}시간 포함</small>` : ''}</td>
      <td class="num">${won(l.unitPrice)} × ${l.qty}${l.kind === 'room' || l.serviceId ? '시간' : ''}</td>
      <td class="num">${won(l.subtotal)}</td></tr>`).join('')}
  </tbody></table>`;
}

function historySection() {
  const list = [...state.payments].reverse();
  const issued = list.reduce((a, p) => a + (p.credit || 0), 0);
  const repaid = list.filter((p) => p.type === 'repay').reduce((a, p) => a + p.base, 0);
  return `<section class="card">
    <h3>결제 내역 ${list.length ? `(${list.length}건)` : ''}</h3>
    ${issued || repaid ? `<p class="credit-note">${issued ? `외상 발생 ${won(issued)}` : ''}${issued && repaid ? ' · ' : ''}${repaid ? `외상 회수 ${won(repaid)}` : ''}</p>` : ''}
    ${list.length ? '' : '<p class="muted">이번 영업일 결제가 아직 없습니다.</p>'}
    ${list.map((p) => `<details class="payment">
      <summary>
        <span>${fmtTime(p.paidAt)} · ${esc(p.roomName)}</span>
        ${p.credit ? `<span class="badge credit">외상 ${won(p.credit)}</span>` : ''}
        <span class="badge ${p.method}">${METHOD_LABELS[p.method]}</span>
        <b>${won(p.amount)}</b>
      </summary>
      ${linesTable(p.lines)}
      <dl class="sum">
        ${p.credit ? `<div><dt>판매액</dt><dd>${won(p.coveredBase)}</dd></div>
          <div class="credit-line"><dt>외상 (나중에 받음)</dt><dd>−${won(p.credit)}</dd></div>` : ''}
        <div><dt>${p.type === 'repay' ? '외상 회수(장부 차감)' : p.credit ? '이번에 받은 판매액' : '판매액'}</dt><dd>${won(p.base)}</dd></div>
        ${p.surcharge ? `<div><dt>카드 가산</dt><dd>+${won(p.surcharge)}</dd></div>` : ''}
        ${p.discount ? `<div><dt>할인</dt><dd>−${won(p.discount)}</dd></div>` : ''}
        <div class="grand"><dt>받은 금액</dt><dd>${won(p.amount)}</dd></div>
      </dl>
    </details>`).join('')}
  </section>`;
}

// 마감 기록(DB 컬럼 형식)의 매상 구조
function closeBreakdown(r) {
  const cat = r.by_category || {};
  const sold = (r.by_item || []).filter((x) => x.kind !== 'comp');
  const comps = (r.by_item || []).filter((x) => x.kind === 'comp');
  return `
    <div class="big-total"><span>총매출(받은 금액)</span><b>${won(r.net_total)}</b></div>
    <dl class="sum">
      <div><dt>현금</dt><dd>${won(r.cash_total)}</dd></div>
      <div><dt>카드</dt><dd>${won(r.card_total)}</dd></div>
    </dl>
    <h4>매상 구조</h4>
    <dl class="sum">
      <div><dt>룸 이용</dt><dd>${won(cat.room)}</dd></div>
      <div><dt>식음료</dt><dd>${won(cat.liquor)}</dd></div>
      <div><dt>기타 서비스</dt><dd>${won(cat.service)}</dd></div>
      ${cat.credit_issued ? `<div><dt>외상 발생 (나중에 받음)</dt><dd>−${won(cat.credit_issued)}</dd></div>` : ''}
      ${cat.credit_repaid ? `<div><dt>외상 회수</dt><dd>+${won(cat.credit_repaid)}</dd></div>` : ''}
      <div class="sub"><dt>판매액 합계</dt><dd>${won(r.gross_sales)}</dd></div>
      <div><dt>카드 가산</dt><dd>+${won(r.card_surcharge_total)}</dd></div>
      <div><dt>할인</dt><dd>−${won(r.discount_total)}</dd></div>
      <div class="grand"><dt>받은 금액</dt><dd>${won(r.net_total)}</dd></div>
    </dl>
    <h4>룸별 매상</h4>
    ${(r.by_room || []).length
      ? `<dl class="sum">${r.by_room.map((x) => `<div><dt>${esc(x.roomName)} (${x.count}건)</dt><dd>${won(x.net)}</dd></div>`).join('')}</dl>`
      : '<p class="muted">없음</p>'}
    ${sold.length ? `<details><summary>품목별 판매</summary>
      <table class="lines"><tbody>${sold.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${x.qty}</td><td class="num">${won(x.sales)}</td></tr>`).join('')}</tbody></table>
    </details>` : ''}
    ${comps.length ? `<h4>서비스 제공 (무료, 매출 아님)</h4>
      <table class="lines"><tbody>${comps.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${x.qty}</td><td class="num muted">정가 ${won(x.value)}</td></tr>`).join('')}</tbody></table>
      <p class="muted">합계 ${comps.reduce((a, x) => a + x.qty, 0)}개 · 정가 기준 ${won(comps.reduce((a, x) => a + x.value, 0))}</p>` : ''}`;
}

// 매출 탭: 이번 영업일 요약 → 일 마감 → 월 매출 캘린더 → 오늘 결제 내역
function salesView() {
  const preview = buildCloseRecord({
    id: state.businessDay.id,
    openedAt: state.businessDay.openedAt,
    closedAt: new Date().toISOString(),
    closedBy: state.managerName,
    cutoffHour: state.settings.dayCutoffHour,
    payments: state.payments,
    comps: state.comps,
  });
  const active = activeRooms();
  const pending = state.pendingUploads;
  return `
    ${staleWarning()}
    <section class="card">
      <h3>${esc(preview.business_date)} 영업 요약</h3>
      <p class="muted">${state.businessDay.openedAt ? `영업 시작 ${fmtDateTime(state.businessDay.openedAt)} · ` : ''}결제 ${preview.payment_count}건</p>
      ${closeBreakdown(preview)}
    </section>
    ${active.length ? `<p class="warn">이용 중인 룸이 있어 마감할 수 없습니다: ${active.map((r) => esc(r.name)).join(', ')}</p>` : ''}
    <button class="btn primary block" data-action="close-day" ${active.length || ui.busy ? 'disabled' : ''}>일 마감</button>
    ${pending.length ? `<section class="card warn-card">
      <p>서버에 올리지 못한 마감 ${pending.length}건이 휴대폰에 있습니다: ${pending.map((p) => esc(p.business_date)).join(', ')}</p>
      <button class="btn block" data-action="retry-upload" ${ui.busy ? 'disabled' : ''}>다시 업로드</button>
    </section>` : ''}
    ${calendarSection()}
    ${creditSection()}
    ${historySection()}`;
}

// 외상 장부: 명단(이름·전화번호·잔액) → 사람별 하위 내역, 상환, 잔액 0원이면 삭제
function creditSection() {
  const c = ui.credit;
  const pending = state.pendingCredits.length;
  const open = (c.accounts || []).filter((a) => a.balance > 0);
  let body;
  if (c.detail) body = creditDetail();
  else if (!c.accounts) body = `<p class="muted">${c.loading ? '외상 명단을 불러오는 중…' : esc(c.error || '명단을 불러오려면 새로고침을 누르세요.')}</p>`;
  else {
    body = `<label class="field"><span>검색 (이름 · 전화번호)</span>
        <input data-input="credit-search" autocomplete="off" value="${esc(c.query)}"></label>
      <div id="credit-list">${creditListRows()}</div>`;
  }
  return `<details class="card fold" data-fold="credit" ${ui.folds.credit ? 'open' : ''}>
    <summary><h3>외상 장부</h3><span class="muted">${c.accounts ? `미상환 ${open.length}명 · 잔액 ${won(open.reduce((a, x) => a + x.balance, 0))}` : '펼치면 서버에서 명단을 불러옵니다'}</span></summary>
    ${pending ? `<div class="warn">서버에 아직 못 보낸 외상 기록 ${pending}건이 이 폰에 있습니다.
      <button class="btn small" data-action="credit-retry" ${ui.busy ? 'disabled' : ''}>다시 보내기</button></div>` : ''}
    ${body}
    ${c.detail ? '' : `<button class="btn small" data-action="credit-reload" ${c.loading ? 'disabled' : ''}>새로고침</button>`}
  </details>`;
}

function creditListRows() {
  const q = ui.credit.query.trim();
  const digits = normalizePhone(q);
  const list = (ui.credit.accounts || []).filter((a) => !q || a.name.includes(q) || (digits && a.phone.includes(digits)));
  if (!list.length) return `<p class="muted">${q ? '검색 결과가 없습니다.' : '외상 명단이 없습니다.'}</p>`;
  return list
    .map((a) => `<button class="credit-row ${a.balance ? '' : 'settled'}" data-action="credit-open" data-id="${esc(a.id)}">
      <span class="who"><b>${esc(a.name)}</b><small>${esc(formatPhone(a.phone))}</small></span>
      <b class="bal">${a.balance ? won(a.balance) : '상환 완료'}</b>
    </button>`)
    .join('');
}

function creditDetail() {
  const { account, balance, entries } = ui.credit.detail;
  const c = ui.credit;
  const rows = entries
    .map((e) => (e.kind === 'issue'
      ? `<li class="issue"><div><b>외상 +${won(e.amount)}</b>
          <small>${fmtDateTime(e.occurred_at)} · ${esc(e.room_name || '')}${e.entered_at ? ` · 입장 ${fmtTime(e.entered_at)}` : ''}${e.room_hours != null ? ` · 룸 ${e.room_hours}시간` : ''}${e.service_hours ? ` · 서비스 ${e.service_hours}시간` : ''}</small></div></li>`
      : `<li class="repay"><div><b>상환 −${won(e.amount)}</b>
          <small>${fmtDateTime(e.occurred_at)} · ${METHOD_LABELS[e.method] || ''}${e.paid_amount && e.paid_amount !== e.amount ? ` · 받은 금액 ${won(e.paid_amount)}` : ''}</small></div></li>`))
    .join('');
  return `<div class="credit-detail">
    <button class="link" data-action="credit-back">‹ 외상 명단</button>
    <div class="row-between"><h4>${esc(account.name)} · ${esc(formatPhone(account.phone))}</h4><b class="bal">${won(balance)}</b></div>
    <ul class="credit-entries">${rows || '<li class="muted">내역 없음</li>'}</ul>
    ${balance > 0 ? `<div class="repay-form">
      <h4>상환 받기</h4>
      <div class="credit-amount">
        <label class="field"><span>상환 금액(원, 장부 차감액)</span>
          <input data-input="repay-amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(c.repayText)}"></label>
        <button class="btn small" data-action="repay-all">전액</button>
      </div>
      <div class="segmented" role="radiogroup" aria-label="상환 결제수단">
        <button role="radio" aria-checked="${c.repayMethod === 'cash'}" data-action="repay-method" data-method="cash">현금</button>
        <button role="radio" aria-checked="${c.repayMethod === 'card'}" data-action="repay-method" data-method="card">카드 (+${CARD_SURCHARGE_PERCENT}%)</button>
      </div>
      <div id="repay-summary">${repaySummary()}</div>
      <button class="btn primary block" data-action="repay-confirm" ${ui.busy ? 'disabled' : ''}>상환 받기</button>
    </div>` : `<p class="muted">전부 상환했습니다. 명단을 지우면 이름·전화번호와 하위 내역이 서버에서 삭제됩니다.</p>
      <button class="btn block danger" data-action="credit-delete" ${ui.busy ? 'disabled' : ''}>명단 삭제</button>`}
  </div>`;
}

function repaySummary() {
  const c = ui.credit;
  if (!c.repayText) return '';
  let r;
  try {
    r = calcRepayment(parseWon(c.repayText, Number.NaN), c.repayMethod, c.detail.balance);
  } catch (e) {
    return `<p class="error" role="alert">${esc(e.message)}</p>`;
  }
  return `<dl class="sum">
    <div><dt>장부에서 차감</dt><dd>${won(r.base)}</dd></div>
    ${r.surcharge ? `<div><dt>카드 가산 ${CARD_SURCHARGE_PERCENT}%</dt><dd>+${won(r.surcharge)}</dd></div>` : ''}
    <div class="grand"><dt>받을 금액</dt><dd>${won(r.amount)}</dd></div>
    <div><dt>상환 후 잔액</dt><dd>${won(c.detail.balance - r.base)}</dd></div>
  </dl>`;
}

async function openCreditAccount(id) {
  ui.credit.loading = true;
  render();
  try {
    const r = await api.getCreditAccount(state.pin, id);
    ui.credit.detail = { account: r.account, balance: r.balance, entries: r.entries };
    ui.credit.repayText = '';
    ui.credit.repayMethod = 'cash';
  } catch (e) {
    ui.notice = `외상 내역을 불러오지 못했습니다: ${e.message}`;
  }
  ui.credit.loading = false;
  render();
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function calendarSection() {
  const cal = ui.calendar;
  const byDate = cal.data ? closesByDate(cal.data.list) : new Map();
  const monthTotal = [...byDate.values()].reduce((a, e) => a + e.net, 0);
  const [y, m] = cal.month.split('-').map(Number);
  const today = businessDate(new Date(), state.settings.dayCutoffHour);
  const isCurrentMonth = cal.month >= monthOf(today);
  const cells = calendarCells(cal.month)
    .map((date) => {
      if (!date) return '<div class="cal-cell empty"></div>';
      const e = byDate.get(date);
      const cls = ['cal-cell', e && 'has', date === today && 'today', date === cal.selected && 'sel'].filter(Boolean).join(' ');
      return `<button class="${cls}" data-action="cal-day" data-date="${date}" ${e ? '' : 'disabled'}
        aria-label="${Number(date.slice(8))}일${e ? ` 매출 ${won(e.net)}` : ''}">
        <span class="cal-d">${Number(date.slice(8))}</span>${e ? `<span class="cal-amt">${compactWon(e.net)}</span>` : ''}${e?.creditIssued ? `<span class="cal-credit">외상 ${compactWon(e.creditIssued)}</span>` : ''}
      </button>`;
    })
    .join('');
  const selected = cal.selected && byDate.get(cal.selected);
  const source = cal.data?.source === 'local' ? '<p class="muted">서버에 연결되지 않아 이 휴대폰에 남은 마감 기록만 보여 줍니다.</p>' : '';
  return `<section class="card">
    <div class="cal-head">
      <button class="icon-btn cal-nav" data-action="cal-month" data-delta="-1" aria-label="이전 달">‹</button>
      <h3>${y}년 ${m}월 매출</h3>
      <button class="icon-btn cal-nav" data-action="cal-month" data-delta="1" aria-label="다음 달" ${isCurrentMonth ? 'disabled' : ''}>›</button>
    </div>
    <div class="big-total"><span>월 합계 · 영업 ${byDate.size}일</span><b>${cal.loading ? '…' : won(monthTotal)}</b></div>
    <div class="cal-grid">
      ${WEEKDAYS.map((w) => `<div class="cal-w">${w}</div>`).join('')}
      ${cells}
    </div>
    ${cal.loading ? '<p class="muted">불러오는 중…</p>' : source}
    ${selected ? `<div class="cal-detail">
      <h4>${esc(cal.selected)} 매출</h4>
      ${selected.creditIssued || selected.creditRepaid ? `<p class="credit-note">${selected.creditIssued ? `외상 발생 ${won(selected.creditIssued)} (매출 제외)` : ''}${selected.creditIssued && selected.creditRepaid ? ' · ' : ''}${selected.creditRepaid ? `외상 회수 ${won(selected.creditRepaid)} (매출 포함)` : ''}</p>` : ''}
      ${selected.closes.map((r) => `<p class="muted">마감 ${fmtDateTime(r.closed_at)}${r.closed_by ? ` · ${esc(r.closed_by)}` : ''} · 결제 ${r.payment_count}건</p>
        ${closeBreakdown(r)}`).join('')}
    </div>` : cal.data && byDate.size ? '<p class="muted">날짜를 누르면 그날 매출 상세를 봅니다.</p>' : ''}
  </section>`;
}

function startDraft() {
  return {
    storeName: state.settings.storeName,
    managerName: state.managerName,
    pin: state.pin,
    dayCutoffHour: String(state.settings.dayCutoffHour),
    rooms: state.settings.rooms.map((r) => ({ ...r, hourlyRate: String(r.hourlyRate) })),
    items: state.settings.items.map((i) => ({ ...i, price: String(i.price) })),
  };
}

function settingsView() {
  if (!ui.draft) ui.draft = startDraft();
  const d = ui.draft;
  const input = (path, value, attrs = '') =>
    `<input data-input="draft" data-path="${path}" value="${esc(value)}" ${attrs}>`;
  const s = state.settings;
  const server = api.isServerConfigured()
    ? `서버 연결 정보 있음${state.settingsDirty ? ' · 서버에 아직 반영되지 않은 변경이 있습니다' : ''}`
    : '서버 미설정 (js/config.js) · 휴대폰에만 저장됩니다';
  return `
    <details class="card fold" data-fold="basic" ${ui.folds.basic ? 'open' : ''}>
      <summary><h3>기본 정보</h3><span class="muted">${esc(d.storeName || '매장명 없음')} · ${esc(d.managerName || '관리자 미입력')} · PIN ${d.pin ? '입력됨' : '없음'}</span></summary>
      <label class="field"><span>매장명</span>${input('storeName', d.storeName, 'autocomplete="off"')}</label>
      <label class="field"><span>관리자 이름 (마감·설정 변경 기록용)</span>${input('managerName', d.managerName, 'autocomplete="off"')}</label>
      <label class="field"><span>매장 PIN (서버 저장용)</span>${input('pin', d.pin, 'type="password" autocomplete="off"')}</label>
      <label class="field"><span>영업일 기준 시각 (0~23시, 이 시각 이전에 시작한 영업은 전날 매출. 기본 12)</span>${input('dayCutoffHour', d.dayCutoffHour, 'inputmode="numeric"')}</label>
    </details>
    <details class="card fold" data-fold="rooms" ${ui.folds.rooms ? 'open' : ''}>
      <summary><h3>룸 요금</h3><span class="muted">${d.rooms.map((r) => `${esc(r.name)} ${won(parseWon(r.hourlyRate))}`).join(' · ')}</span></summary>
      ${d.rooms.map((r, i) => `<div class="grid-2">
        <label class="field"><span>룸 이름</span>${input(`rooms.${i}.name`, r.name)}</label>
        <label class="field"><span>시간당 요금(원)</span>${input(`rooms.${i}.hourlyRate`, r.hourlyRate, 'inputmode="numeric"')}</label>
      </div>`).join('')}
    </details>
    <details class="card fold" data-fold="items" ${ui.folds.items ? 'open' : ''}>
      <summary><h3>판매 품목</h3><span class="muted">식음료 ${d.items.filter((i) => i.category === 'liquor').length}개 · 기타 서비스 ${d.items.filter((i) => i.category === 'service').length}개</span></summary>
      <p class="muted">식음료는 수량으로 세고, 기타 서비스는 1명·1시간 가격을 입력합니다(시간제).</p>
      ${d.items.length ? '' : '<p class="muted">품목이 없습니다.</p>'}
      ${d.items.map((it, i) => `<div class="item-edit">
        <label class="field grow"><span>이름</span>${input(`items.${i}.name`, it.name, 'autocomplete="off"')}</label>
        <label class="field"><span>분류</span>
          <select data-input="draft" data-path="items.${i}.category">
            <option value="liquor" ${it.category === 'liquor' ? 'selected' : ''}>식음료</option>
            <option value="service" ${it.category === 'service' ? 'selected' : ''}>기타 서비스(시간제)</option>
          </select></label>
        <label class="field"><span>가격(원)</span>${input(`items.${i}.price`, it.price, 'inputmode="numeric"')}</label>
        <label class="check"><input type="checkbox" data-input="draft" data-path="items.${i}.active" ${it.active ? 'checked' : ''}> 판매 중</label>
        <button class="btn small danger" data-action="delete-item" data-index="${i}">삭제</button>
      </div>`).join('')}
      <button class="btn block" data-action="add-item">+ 품목 추가</button>
    </details>
    <p class="muted">${esc(server)}${s.updatedAt ? `<br>마지막 변경 ${fmtDateTime(s.updatedAt)}${s.updatedBy ? ` · ${esc(s.updatedBy)}` : ''}` : ''}</p>
    <div class="actions">
      <button class="btn" data-action="reset-draft">되돌리기</button>
      <button class="btn primary" data-action="save-settings" ${ui.busy ? 'disabled' : ''}>설정 저장</button>
    </div>
    <section class="card">
      <h3>데이터 백업</h3>
      <p class="muted">마감 기록은 서버에 저장됩니다. 영업 도중 휴대폰을 바꿀 때만 백업 파일로 옮기세요.</p>
      <div class="actions">
        <button class="btn" data-action="export-backup">백업 내보내기</button>
        <label class="btn file-btn">백업 가져오기<input type="file" accept="application/json,.json" data-input="import"></label>
      </div>
    </section>
    <p class="muted center">앱 버전 ${esc(ui.appVersion || '확인 중')}</p>`;
}

// ── 동작 ─────────────────────────────────────────────

const actions = {
  'dismiss-notice': () => notify(''),
  sync: () => syncAll(),
  tab: (el) => {
    if (ui.tab === el.dataset.tab && el.dataset.tab === 'rooms') ui.roomId = null;
    if (ui.tab !== el.dataset.tab && el.dataset.tab !== 'rooms') navPush();
    ui.tab = el.dataset.tab;
    render();
    if (ui.tab === 'sales' && !ui.calendar.data && !ui.calendar.loading) loadMonth(ui.calendar.month);
  },
  'start-room': (el) => {
    const stale = staleBusinessDate();
    if (stale && !confirm(`${stale} 영업이 아직 마감되지 않았습니다.\n지금 시작하면 이 손님 매출도 ${stale} 매출로 기록됩니다.\n\n그래도 시작할까요? (취소 후 매출 탭에서 먼저 마감할 수 있습니다)`)) {
      return;
    }
    const now = new Date().toISOString();
    const id = el.dataset.room;
    state.sessions[id] = { id: newId(), startedAt: now, hours: 0, quantities: {}, paidHours: 0, paidQuantities: {}, freeQuantities: {}, guests: 0, declined: 0, services: [] };
    if (!state.businessDay.openedAt) state.businessDay.openedAt = now;
    ui.roomId = id;
    navPush();
    commit();
  },
  'open-room': (el) => {
    ui.roomId = el.dataset.room;
    navPush();
    render();
    window.scrollTo(0, 0);
  },
  back: () => {
    ui.roomId = null;
    render();
  },
  category: (el) => {
    ui.category = el.dataset.category;
    render();
  },
  'calc-count': (el) => {
    const n = (ui.calc.counts[el.dataset.key] || 0) + Number(el.dataset.delta);
    ui.calc.counts[el.dataset.key] = Math.max(0, n);
    render();
  },
  'calc-method': (el) => {
    ui.calc.method = el.dataset.method;
    render();
  },
  'calc-people': (el) => {
    ui.calc.people = Math.max(1, ui.calc.people + Number(el.dataset.delta));
    render();
  },
  'calc-reset': () => {
    ui.calc = { counts: {}, method: 'cash', people: 1 };
    render();
  },
  guests: (el) => updateSession((s) => changeGuests(s, Number(el.dataset.delta))),
  // 손님이 이용하지 않고 나간 경우: 담은 주문(미결제)은 취소하고 룸을 비운다. 이미 받은 결제는 매출에 그대로 남는다.
  'room-cancel': () => {
    const room = roomById(ui.roomId);
    const s = state.sessions[room.id];
    // 기타 서비스를 시작한 룸은 이용안함 처리하지 않는다(버튼도 숨기지만 한 번 더 막는다).
    if ((s.services || []).length) return;
    const paid = sessionPaid(s);
    const balance = balanceOf(room, s);
    const detail = [
      balance ? `미결제 ${won(balance)}는 취소됩니다.` : '',
      paid ? `이미 받은 ${won(paid)}는 매출에 그대로 남습니다.` : '',
    ].filter(Boolean).join('\n');
    if (!confirm(`${room.name}을(를) 이용안함으로 처리하고 비울까요?${detail ? `\n\n${detail}` : ''}`)) return;
    closeSession(room.id);
    ui.roomId = null;
    ui.notice = `${room.name}을(를) 이용안함으로 비웠습니다.`;
    commit();
  },
  'svc-add': (el) => updateSession((s) => addService(s, el.dataset.item, new Date().toISOString(), newId())),
  'svc-inc': (el) => updateSession((s) => changeServiceHours(s, el.dataset.id, 1)),
  'svc-dec': (el) => updateSession((s) => changeServiceHours(s, el.dataset.id, -1)),
  'svc-remove': (el) => {
    const card = el.closest('.svc-card')?.querySelector('.svc-top b')?.textContent || '이 서비스';
    if (!confirm(`${card}을(를) 삭제할까요?\n잘못 추가한 경우에만 삭제해 주세요.`)) return;
    updateSession((s) => removeService(s, el.dataset.id));
  },
  inc: (el) => updateCount(el.dataset.key, 1),
  dec: (el) => updateCount(el.dataset.key, -1),
  free: (el) => updateSession((s) => changeFreeCount(s, el.dataset.key, Number(el.dataset.delta))),
  'open-payment': () => {
    ui.payment = newPaymentUi(ui.roomId, false);
    navPush();
    render();
  },
  'credit-open': (el) => {
    navPush();
    openCreditAccount(el.dataset.id);
  },
  'credit-back': () => {
    ui.credit.detail = null;
    render();
  },
  'credit-reload': () => {
    ui.credit.accounts = null;
    loadCreditAccounts();
  },
  'credit-retry': () => uploadCredits(),
  'repay-all': () => {
    ui.credit.repayText = String(ui.credit.detail.balance);
    render();
  },
  'repay-method': (el) => {
    ui.credit.repayMethod = el.dataset.method;
    render();
  },
  // 상환: 서버 장부에 먼저 기록한 뒤(잔액 검사) 그날 매출(외상 회수)로 잡는다.
  'repay-confirm': async () => {
    const c = ui.credit;
    const { account, balance } = c.detail;
    const amount = parseWon(c.repayText, Number.NaN);
    let r;
    try {
      r = calcRepayment(amount, c.repayMethod, balance);
    } catch (e) {
      alert(e.message);
      return;
    }
    if (!confirm(`${account.name} 외상 ${won(amount)} 상환\n${METHOD_LABELS[c.repayMethod]}로 ${won(r.amount)}을(를) 받을까요?`)) return;
    const now = new Date();
    const entry = {
      id: newId(), kind: 'repay', phone: account.phone, amount, method: c.repayMethod, paid_amount: r.amount,
      occurred_at: now.toISOString(), business_date: currentBusinessDate(), created_by: state.managerName || null,
    };
    ui.busy = true;
    render();
    try {
      await api.addCreditEntry(state.pin, entry);
    } catch (e) {
      ui.busy = false;
      notify(`상환을 기록하지 못했습니다: ${e.message}`);
      return;
    }
    state.payments.push({
      id: newId(), type: 'repay', roomId: null, roomName: '외상 회수', sessionId: null, paidAt: now.toISOString(),
      method: c.repayMethod, lines: [], creditEntryId: entry.id, credit: 0, coveredBase: 0, ...r,
    });
    ui.busy = false;
    ui.notice = `${account.name} 외상 ${won(amount)} 상환(${METHOD_LABELS[c.repayMethod]} ${won(r.amount)})을 기록했습니다.`;
    ui.credit.accounts = null;
    commit();
    await openCreditAccount(account.id);
    loadCreditAccounts();
  },
  'credit-delete': async () => {
    const { account } = ui.credit.detail;
    if (!confirm(`${account.name} (${formatPhone(account.phone)}) 명단을 삭제할까요?\n이름·전화번호와 하위 내역이 모두 지워지며 되돌릴 수 없습니다.`)) return;
    ui.busy = true;
    render();
    try {
      await api.deleteCreditAccount(state.pin, account.id);
      ui.credit.detail = null;
      ui.credit.accounts = null;
      ui.notice = `${account.name} 외상 명단을 삭제했습니다.`;
    } catch (e) {
      ui.notice = `삭제하지 못했습니다: ${e.message}`;
    }
    ui.busy = false;
    render();
    loadCreditAccounts();
  },
  'credit-all': (el) => {
    ui.payment.creditText = el.dataset.base;
    render();
  },
  'credit-pick': (el) => {
    ui.payment.creditPhone = formatPhone(el.dataset.phone);
    ui.payment.creditName = el.dataset.name;
    render();
  },
  'end-room': () => {
    const room = roomById(ui.roomId);
    const s = state.sessions[room.id];
    if (balanceOf(room, s) > 0) {
      ui.payment = newPaymentUi(room.id, true);
      navPush();
      render();
      return;
    }
    if (!confirm(`${room.name}을(를) 종료할까요?\n다음 손님은 [손님 입장]을 눌러 새로 시작합니다.`)) return;
    closeSession(room.id);
    ui.roomId = null;
    commit();
  },
  'pay-method': (el) => {
    ui.payment.method = el.dataset.method;
    render();
  },
  'cancel-payment': () => {
    ui.payment = null;
    render();
  },
  'confirm-payment': confirmPayment,
  'close-day': closeDay,
  'retry-upload': () => uploadPending(),
  'cal-month': (el) => loadMonth(shiftMonth(ui.calendar.month, Number(el.dataset.delta))),
  'cal-day': (el) => {
    ui.calendar.selected = ui.calendar.selected === el.dataset.date ? null : el.dataset.date;
    render();
  },
  'add-item': () => {
    ui.draft.items.push({ id: newId(), name: '', category: 'liquor', price: '', active: true });
    render();
    const inputs = app.querySelectorAll('.item-edit input[data-path$=".name"]');
    inputs[inputs.length - 1]?.focus();
  },
  'delete-item': (el) => {
    const item = ui.draft.items[Number(el.dataset.index)];
    const inUse = Object.values(state.sessions).some(
      (s) => s && ((s.quantities[item.id] || 0) > 0 || (s.services || []).some((v) => v.itemId === item.id)),
    );
    if (inUse) {
      alert(`이용 중인 룸에서 "${item.name}"을(를) 판매 중이라 삭제할 수 없습니다.\n대신 '판매 중'을 끄면 새로 추가되지 않습니다.`);
      return;
    }
    if (!confirm(`"${item.name || '이름 없는 품목'}"을(를) 삭제할까요? (설정 저장을 눌러야 반영됩니다)`)) return;
    ui.draft.items.splice(Number(el.dataset.index), 1);
    render();
  },
  'reset-draft': () => {
    ui.draft = null;
    render();
  },
  'save-settings': saveSettingsDraft,
  'export-backup': () => {
    downloadFile(`store-backup-${currentBusinessDate()}.json`, exportBackup(state));
  },
};

function newPaymentUi(roomId, endAfter) {
  return { roomId, method: 'cash', discountText: '', endAfter, creditOpen: false, creditText: '', creditPhone: '', creditName: '' };
}

// 외상 명단(서버). 결제 화면 외상 영역을 펼치거나 외상 장부를 열 때 불러온다.
async function loadCreditAccounts() {
  if (ui.credit.loading) return;
  if (!api.isServerConfigured() || !state.pin) {
    ui.credit.error = '외상 명단은 서버와 매장 PIN이 있어야 볼 수 있습니다(외상 기록은 폰에 보관했다가 나중에 보냅니다).';
    refreshCreditViews();
    return;
  }
  ui.credit.loading = true;
  refreshCreditViews();
  try {
    const r = await api.listCreditAccounts(state.pin, '');
    ui.credit.accounts = r.accounts;
    ui.credit.error = '';
  } catch (e) {
    ui.credit.error = `외상 명단을 불러오지 못했습니다: ${e.message}`;
  }
  ui.credit.loading = false;
  refreshCreditViews();
}

// 결제 화면이 열려 있으면 입력 중인 칸을 지키려고 명단 안내 부분만 다시 그린다.
function refreshCreditViews() {
  const match = document.getElementById('credit-match');
  if (ui.payment && match) match.innerHTML = creditMatch();
  else render();
}

// 룸을 비운다. 서비스(무료)로 내준 식음료가 있으면 이번 영업일 제공 기록(comps)에 남긴다.
function closeSession(roomId) {
  const s = state.sessions[roomId];
  const given = s ? freeItems(s, state.settings.items) : [];
  if (given.length) {
    state.comps = [
      ...state.comps,
      { id: newId(), roomId, roomName: roomById(roomId).name, sessionId: s.id, at: new Date().toISOString(), items: given },
    ];
  }
  state.sessions[roomId] = null;
}

function updateSession(change) {
  const s = state.sessions[ui.roomId];
  const next = change(s);
  if (next === s) return;
  state.sessions[ui.roomId] = next;
  commit();
}

const updateCount = (key, delta) => updateSession((s) => changeCount(s, key, delta));

function confirmPayment() {
  const { roomId, method, discountText, endAfter, creditText, creditPhone, creditName } = ui.payment;
  const room = roomById(roomId);
  const s = state.sessions[roomId];
  // 초과분 계산과 서비스 시간 확정에 같은 시각을 써서 결제 금액과 연장 시간이 어긋나지 않게 한다.
  const now = new Date();
  const lines = unpaidLines(s, room, state.settings.items, now);
  const base = sumLines(lines);
  if (base === 0) return;
  let result;
  try {
    result = calcPaymentWithCredit(base, method, parseWon(discountText), parseWon(creditText));
  } catch (e) {
    alert(e.message);
    return;
  }
  // 외상이 있으면 전화번호(같은 사람 판단)와 이름이 필요하다. 이름이 비어 있으면 기존 명단 이름을 쓴다.
  let creditEntry = null;
  if (result.credit) {
    const phone = normalizePhone(creditPhone);
    const known = ui.credit.accounts?.find((a) => a.phone === phone);
    const name = (creditName || '').trim() || known?.name || '';
    if (phone.length < 9) return alert('외상 고객 전화번호를 9자리 이상 숫자로 입력해 주세요.');
    if (!name) return alert('외상 고객 이름을 입력해 주세요.');
    if (!confirm(`${name} (${formatPhone(phone)}) 외상 ${won(result.credit)}을(를) 기록하고 ${won(result.amount)}을(를) 받을까요?`)) return;
    creditEntry = { id: newId(), kind: 'issue', phone, name, amount: result.credit };
  }
  const paidSession = markSessionPaid(s, now);
  if (creditEntry) {
    // 하위 내역: 언제, 어느 룸, 입장 시각, 룸·서비스 시간
    Object.assign(creditEntry, {
      occurred_at: now.toISOString(),
      business_date: currentBusinessDate(),
      room_name: room.name,
      entered_at: s.startedAt,
      room_hours: paidSession.hours,
      service_hours: paidSession.services.reduce((a, v) => a + v.hours, 0),
      created_by: state.managerName || null,
    });
    state.pendingCredits = [...state.pendingCredits, creditEntry];
  }
  state.payments.push({
    id: newId(),
    roomId,
    roomName: room.name,
    sessionId: s.id,
    paidAt: now.toISOString(),
    method,
    lines,
    // 결제 기록에는 개인정보 없이 외상 기록 id만 남긴다.
    ...(creditEntry ? { creditEntryId: creditEntry.id } : {}),
    ...result,
  });
  state.sessions[roomId] = paidSession;
  ui.payment = null;
  ui.notice = `${room.name} ${METHOD_LABELS[method]} ${won(result.amount)} 결제했습니다.${creditEntry ? ` 외상 ${won(creditEntry.amount)} 기록.` : ''}`;
  if (endAfter) {
    closeSession(roomId);
    ui.roomId = null;
    ui.notice += ' 룸을 종료했습니다.';
  }
  commit();
  if (creditEntry) uploadCredits();
}

// 외상 발생 기록을 서버에 보낸다. 실패하면 폰에 남겨 두고 다음 동기화 때 다시 보낸다.
async function uploadCredits() {
  if (!state.pendingCredits.length || !api.isServerConfigured() || !state.pin || ui.credit.sending) return;
  ui.credit.sending = true;
  const sent = [];
  let error = '';
  for (const entry of state.pendingCredits) {
    try {
      await api.addCreditEntry(state.pin, entry);
      sent.push(entry.id);
    } catch (e) {
      error = e.message;
      break;
    }
  }
  ui.credit.sending = false;
  state.pendingCredits = state.pendingCredits.filter((p) => !sent.includes(p.id));
  if (sent.length) ui.credit.accounts = null; // 명단을 새로 받게 한다
  if (error) ui.notice = `외상 기록을 서버에 보내지 못했습니다: ${error} (폰에 보관 중, 동기화 때 다시 보냅니다)`;
  commit();
}

async function closeDay() {
  const active = activeRooms();
  if (active.length) {
    alert(`이용 중인 룸이 있어 마감할 수 없습니다: ${active.map((r) => r.name).join(', ')}\n룸을 모두 종료한 뒤 마감해 주세요.`);
    return;
  }
  const record = buildCloseRecord({
    id: state.businessDay.id,
    openedAt: state.businessDay.openedAt,
    closedAt: new Date().toISOString(),
    closedBy: state.managerName,
    cutoffHour: state.settings.dayCutoffHour,
    payments: state.payments,
    comps: state.comps,
  });
  const empty = record.payment_count === 0 ? '\n\n※ 이번 영업일에 결제가 없습니다.' : '';
  const ok = confirm(
    `${record.business_date} 영업을 마감합니다.\n결제 ${record.payment_count}건 · 총매출 ${won(record.net_total)}` +
      `${record.by_category.credit_issued ? `\n외상 발생 ${won(record.by_category.credit_issued)} (매출 제외)` : ''}` +
      `${record.by_category.credit_repaid ? `\n외상 회수 ${won(record.by_category.credit_repaid)} (매출 포함)` : ''}${empty}\n\n` +
      '마감하면 서버에 저장하고 새 영업일을 시작합니다.',
  );
  if (!ok) return;

  // 업로드 전에 휴대폰에 먼저 보관해, 업로드가 실패해도 기록을 잃지 않고 재시도한다.
  state.pendingUploads = [...state.pendingUploads.filter((p) => p.id !== record.id), record];
  state.closeHistory = addCloseHistory(state.closeHistory, record);
  state.payments = [];
  state.comps = [];
  state.businessDay = { id: newId(), openedAt: null };
  ui.notice = `${record.business_date} 마감했습니다.`;
  commit();
  await uploadPending();
  loadMonth(monthOf(record.business_date));
}

async function uploadPending() {
  if (ui.busy || !state.pendingUploads.length) return;
  if (!api.isServerConfigured()) {
    notify(`${ui.notice} 서버가 설정되지 않아 업로드하지 않았습니다(매출 탭에 보관).`.trim());
    return;
  }
  if (!state.pin) {
    notify('서버 업로드에 PIN이 필요합니다. 관리 탭에서 매장 PIN을 입력해 주세요.');
    return;
  }
  ui.busy = true;
  render();
  const done = [];
  let error = '';
  let sameDate = false;
  for (const record of state.pendingUploads) {
    try {
      const r = await api.submitDayClose(state.pin, record);
      done.push(record.id);
      if (r.same_date_count > 0) sameDate = true;
    } catch (e) {
      error = e.message;
      break;
    }
  }
  state.pendingUploads = state.pendingUploads.filter((p) => !done.includes(p.id));
  ui.busy = false;
  if (error) {
    ui.notice = `마감 업로드 실패: ${error} (휴대폰에 보관 중이며 매출 탭에서 다시 올릴 수 있습니다)`;
  } else {
    ui.notice = `마감 ${done.length}건을 서버에 저장했습니다.${sameDate ? ' 같은 날짜의 마감이 이미 있어 별도 건으로 저장했습니다.' : ''}`;
  }
  commit();
}

// 매출 캘린더: 한 달치 마감 기록을 서버에서 받는다. 서버를 못 쓰면 휴대폰에 남은 마감 요약을 쓴다.
async function loadMonth(month) {
  const cal = ui.calendar;
  cal.month = month;
  cal.selected = null;
  cal.data = null;
  cal.loading = true;
  render();
  const { from, to } = monthRange(month);
  const local = () => state.closeHistory.filter((r) => r.business_date >= from && r.business_date <= to);
  let data;
  if (!api.isServerConfigured() || !state.pin) {
    data = { source: 'local', list: local() };
  } else {
    try {
      const r = await api.listDayCloses(state.pin, from, to);
      data = { source: 'server', list: r.closes };
    } catch (e) {
      data = { source: 'local', list: local() };
      ui.notice = `서버에서 매출을 불러오지 못해 휴대폰 기록을 보여 줍니다: ${e.message}`;
    }
  }
  if (cal.month !== month) return; // 불러오는 사이 다른 달로 옮겼다
  cal.data = data;
  cal.loading = false;
  render();
}

function settingsPayload(settings) {
  const { updatedAt, updatedBy, ...data } = settings;
  return { ...data, updatedAt, updatedBy };
}

async function saveSettingsDraft() {
  const d = ui.draft;
  const next = {
    storeName: d.storeName.trim(),
    rooms: d.rooms.map((r) => ({ id: r.id, name: r.name.trim(), hourlyRate: parseWon(r.hourlyRate, Number.NaN) })),
    items: d.items.map((i) => ({
      id: i.id,
      name: i.name.trim(),
      category: i.category,
      price: parseWon(i.price, Number.NaN),
      active: i.active,
    })),
    dayCutoffHour: parseWon(d.dayCutoffHour, Number.NaN),
    settingsVersion: SETTINGS_VERSION,
  };
  const errors = validateSettings(next);
  if (errors.length) {
    alert(errors.join('\n'));
    return;
  }
  const pinChanged = d.pin.trim() !== state.pin;
  state.managerName = d.managerName.trim();
  state.pin = d.pin.trim();
  state.settings = { ...next, updatedAt: new Date().toISOString(), updatedBy: state.managerName || null };
  state.settingsDirty = true;
  ui.draft = null;
  ui.notice = '휴대폰에 설정을 저장했습니다.';
  commit();
  await pushSettings();
  if (pinChanged) await uploadPending();
}

async function pushSettings() {
  if (!api.isServerConfigured()) return;
  if (!state.pin) {
    notify('휴대폰에 저장했습니다. 서버에 저장하려면 매장 PIN을 입력해 주세요.');
    return;
  }
  ui.busy = true;
  render();
  try {
    const r = await api.saveSettings(state.pin, settingsPayload(state.settings), state.managerName);
    state.settingsDirty = false;
    state.settingsServerUpdatedAt = r.updated_at;
    ui.notice = '설정을 저장했습니다. (서버 반영 완료)';
  } catch (e) {
    ui.notice = `휴대폰에는 저장했지만 서버 저장에 실패했습니다: ${e.message}`;
  }
  ui.busy = false;
  commit();
}

// 앱을 열 때 서버 설정을 받는다. 이 폰에서 바꾼 뒤 못 올린 설정은, 그사이 서버가 바뀌지 않았을 때만 올린다.
async function syncSettings() {
  if (!api.isServerConfigured() || !state.pin) return;
  let r;
  try {
    r = await api.fetchSettings(state.pin);
  } catch (e) {
    notify(`서버 설정을 불러오지 못했습니다: ${e.message} (휴대폰에 저장된 설정으로 영업합니다)`);
    return;
  }
  const serverChanged = r.updated_at && r.updated_at !== state.settingsServerUpdatedAt;
  if (state.settingsDirty && !serverChanged) {
    await pushSettings();
    return;
  }
  if (!r.settings) return;
  if (state.settingsDirty) {
    ui.notice = '다른 기기에서 바뀐 설정이 있어 서버 설정을 적용했습니다. 이 휴대폰에서 바꾼 내용은 반영되지 않았습니다.';
  }
  state.settings = mergeServerSettings(state.settings, r.settings, state.sessions);
  state.settingsDirty = false;
  state.settingsServerUpdatedAt = r.updated_at;
  ui.draft = null;
  commit();
}

async function importBackup(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  let imported;
  try {
    imported = parseBackup(await file.text());
  } catch (e) {
    alert(`가져오지 못했습니다: ${e.message}`);
    return;
  }
  if (!confirm('현재 휴대폰 데이터를 백업 파일 내용으로 바꿉니다. 계속할까요?\n(PIN은 유지합니다)')) return;
  state = { ...imported, pin: state.pin };
  ui.draft = null;
  ui.roomId = null;
  ui.calendar.data = null;
  ui.notice = '백업 파일을 가져왔습니다.';
  commit();
}

// ── 이벤트 ───────────────────────────────────────────

function setDraft(path, value) {
  const keys = path.split('.');
  let target = ui.draft;
  for (const k of keys.slice(0, -1)) target = target[k];
  target[keys[keys.length - 1]] = value;
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  actions[el.dataset.action]?.(el);
});

const PAYMENT_INPUTS = { discount: 'discountText', 'credit-amount': 'creditText', 'credit-phone': 'creditPhone', 'credit-name': 'creditName' };

function onInput(e) {
  const el = e.target;
  if (PAYMENT_INPUTS[el.dataset.input]) {
    // 입력 중 포커스를 잃지 않도록 합계·명단 안내 부분만 다시 그린다.
    ui.payment[PAYMENT_INPUTS[el.dataset.input]] = el.value;
    const { roomId, method, discountText, creditText } = ui.payment;
    const base = sumLines(unpaidLines(state.sessions[roomId], roomById(roomId), state.settings.items));
    document.getElementById('pay-summary').innerHTML = paymentSummary(base, method, discountText, creditText);
    document.getElementById('confirm-payment').disabled = !!document.querySelector('#pay-summary .error');
    const match = document.getElementById('credit-match');
    if (match) match.innerHTML = creditMatch();
  } else if (el.dataset.input === 'credit-search') {
    ui.credit.query = el.value;
    const list = document.getElementById('credit-list');
    if (list) list.innerHTML = creditListRows();
  } else if (el.dataset.input === 'repay-amount') {
    ui.credit.repayText = el.value;
    const sum = document.getElementById('repay-summary');
    if (sum) sum.innerHTML = repaySummary();
  } else if (el.dataset.input === 'draft') {
    setDraft(el.dataset.path, el.type === 'checkbox' ? el.checked : el.value);
  }
}
app.addEventListener('input', onInput);
app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.input === 'import') importBackup(el);
  else if (el.dataset.input === 'svc-start') {
    // 시각 입력을 마친 뒤(change)에만 반영해, 입력 도중 화면이 다시 그려지지 않게 한다.
    el.blur();
    updateSession((s) => {
      const svc = (s.services || []).find((v) => v.id === el.dataset.id);
      return svc && el.value ? setServiceStart(s, svc.id, withTimeOfDay(svc.startedAt, el.value)) : s;
    });
  } else onInput(e);
});

// ── 휴대폰 뒤로가기 ──
// 뒤로가기는 앱 안에서 한 단계씩 돌아간다: 결제 창 → 외상 내역 → 룸 화면 → 룸 목록(룸 탭).
// 룸 목록에서는 브라우저·앱이 닫히지 않도록 히스토리 한 칸을 다시 채운다.
function navPush() {
  try {
    history.pushState({ storeManager: 'nav' }, '');
  } catch {
    /* 히스토리를 못 쓰는 환경이면 기본 동작을 따른다 */
  }
}

function goBackInApp() {
  if (ui.payment) ui.payment = null;
  else if (ui.tab === 'sales' && ui.credit.detail) ui.credit.detail = null;
  else if (ui.tab === 'rooms' && ui.roomId) ui.roomId = null;
  else if (ui.tab !== 'rooms') ui.tab = 'rooms';
  else return false;
  return true;
}

window.addEventListener('popstate', () => {
  const moved = goBackInApp();
  if (!moved) ui.notice = '룸 목록입니다. 앱을 나가려면 휴대폰 홈 버튼을 사용해 주세요.';
  if (history.state?.storeManager !== 'nav') navPush(); // 다음 뒤로가기도 앱 안에서 처리
  render();
  window.scrollTo(0, 0);
});

// toggle 이벤트는 버블링되지 않아 capture로 받는다. 다시 그려도 접힘 상태를 유지한다.
app.addEventListener(
  'toggle',
  (e) => {
    const key = e.target.dataset?.fold;
    if (key === 'pay-credit' && ui.payment) {
      ui.payment.creditOpen = e.target.open;
      if (e.target.open && !ui.credit.accounts) loadCreditAccounts();
    } else if (key && key in ui.folds) {
      ui.folds[key] = e.target.open;
      if (key === 'credit' && e.target.open && !ui.credit.accounts) loadCreditAccounts();
    }
  },
  true,
);

// 경과 시간 표시를 갱신한다. 입력 중이거나 결제 화면이 열려 있으면 건너뛴다.
const isEditing = () => Boolean(ui.payment || document.activeElement?.matches('input, select'));
setInterval(() => {
  if (ui.tab === 'rooms' && !isEditing()) render();
}, 30000);

// ── 앱 업데이트·동기화 ───────────────────────────────

async function readAppVersion() {
  try {
    // 새 버전으로 넘어가는 순간에는 이전 캐시가 잠시 남아 있으므로 가장 높은 번호를 쓴다.
    const versions = (await caches.keys())
      .map((k) => /^store-manager-v(\d+)$/.exec(k)?.[1])
      .filter(Boolean)
      .map(Number);
    ui.appVersion = versions.length ? `v${Math.max(...versions)}` : '';
  } catch {
    ui.appVersion = '';
  }
}

// 새 버전이 활성화되면 다시 불러와 새 화면을 적용한다. 결제·입력 중이면 미룬다.
function reloadWhenIdle() {
  if (isEditing()) {
    ui.updateReady = true;
    notify('새 버전이 준비됐습니다. 입력을 마친 뒤 [동기화]를 누르면 적용됩니다.');
    return;
  }
  location.reload();
}

// 최신 앱 확인 → 서버 설정 받기 → 못 올린 마감 업로드 → 매출 캘린더 새로 받기
async function syncAll() {
  if (ui.busy) return;
  if (ui.updateReady) {
    location.reload();
    return;
  }
  ui.notice = '동기화 중…';
  render();
  const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
  await reg?.update().catch(() => {});
  if (reg?.installing || reg?.waiting) {
    notify('새 버전을 받는 중입니다. 잠시 후 자동으로 다시 열립니다.');
    return;
  }
  await syncSettings();
  await uploadPending();
  await uploadCredits();
  ui.credit.accounts = null;
  ui.credit.detail = null;
  if (ui.tab === 'sales') await loadMonth(ui.calendar.month);
  else ui.calendar.data = null;
  if (ui.notice === '동기화 중…') {
    notify(`동기화했습니다. 최신 앱(${ui.appVersion || '버전 확인 불가'})과 서버 데이터를 사용 중입니다.`);
  }
}

// 이미 쓰던 버전이 있을 때 새 버전이 활성화되면 다시 연다(첫 설치 때는 다시 열지 않는다).
function watchForUpdates(reg) {
  reg.addEventListener('updatefound', () => {
    const hadActive = Boolean(reg.active);
    const worker = reg.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'activated' && hadActive) reloadWhenIdle();
    });
  });
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => watchForUpdates(reg))
    .then(() => navigator.serviceWorker.ready)
    .then(readAppVersion)
    .then(() => ui.tab === 'settings' && render())
    .catch((e) => console.warn('service worker 등록 실패', e));
  // 홈 화면 앱은 닫지 않고 다시 열면 새로고침되지 않으므로, 화면에 돌아올 때마다 새 버전을 확인한다.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => {});
  });
}

try {
  history.replaceState({ storeManager: 'root' }, '');
} catch {
  /* 무시 */
}
navPush();
render();
syncSettings().then(() => uploadPending()).then(() => uploadCredits());
