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
  overtimeCharge,
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
  basicOpen: !state.pin, // 관리 탭 기본 정보 펼침(PIN이 없을 때만 처음부터 펼친다)
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
    ${state.settings.items.length ? '' : '<p class="empty">관리 탭에서 판매 품목과 룸 요금을 먼저 입력해 주세요.</p>'}`;
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
  const extra = status === 'over' ? overtimeCharge(services, state.settings.items, now) : 0;
  return `<button class="room-tile st-${status}" data-action="open-room" data-room="${room.id}">
    <div class="room-head"><h2>${esc(room.name)}</h2>
      <span class="status-badge st-${status}">${ROOM_STATUS_LABELS[status](g)}</span></div>
    <div class="room-meta">${meta}</div>
    ${services.length ? `<div class="svc-grid">${services.map((v, i) => serviceTimeChip(v, i + 1, now)).join('')}</div>` : ''}
    <dl class="room-money">
      <div><dt>결제 완료</dt><dd>${won(paid)}</dd></div>
      <div class="${balance ? 'due' : ''}"><dt>미결제</dt><dd>${won(balance)}</dd></div>
      ${extra ? `<div class="extra"><dt>초과 추가</dt><dd>+${won(extra)}</dd></div>` : ''}
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
function menuCard(item, s) {
  const qty = s.quantities[item.id] || 0;
  const paid = s.paidQuantities[item.id] || 0;
  return `<div class="menu-card ${qty ? 'picked' : ''}">
    <div class="menu-name">${esc(item.name)}</div>
    <div class="menu-price">${won(item.price)}${paid ? ` · 결제 ${paid}` : ''}</div>
    <div class="counter">
      <button class="step" data-action="dec" data-key="${esc(item.id)}" ${qty <= paid ? 'disabled' : ''} aria-label="${esc(item.name)} 빼기">−</button>
      <span class="qty" aria-label="${esc(item.name)} 수량">${qty}</span>
      <button class="step" data-action="inc" data-key="${esc(item.id)}" aria-label="${esc(item.name)} 담기">+</button>
    </div>
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
        <small>${svc.paidHours ? `결제 ${svc.paidHours}시간` : '미결제'}</small></div>
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

function paymentSummary(base, method, discountText) {
  let r;
  try {
    r = calcPayment(base, method, parseWon(discountText));
  } catch (e) {
    return `<p class="error" role="alert">${esc(e.message)}</p>`;
  }
  return `<dl class="sum">
    <div><dt>판매액</dt><dd>${won(r.base)}</dd></div>
    ${method === 'card' ? `<div><dt>카드 가산 ${CARD_SURCHARGE_PERCENT}%</dt><dd>+${won(r.surcharge)}</dd></div>` : ''}
    ${r.discount ? `<div><dt>할인</dt><dd>−${won(r.discount)}</dd></div>` : ''}
    <div class="grand"><dt>받을 금액</dt><dd>${won(r.amount)}</dd></div>
  </dl>`;
}

function paymentSheet() {
  const { roomId, method, discountText, endAfter } = ui.payment;
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
      ${linesTable(lines)}
      <div class="segmented big" role="radiogroup" aria-label="결제수단">
        <button role="radio" aria-checked="${method === 'cash'}" data-action="pay-method" data-method="cash">현금<small>판매액 그대로</small></button>
        <button role="radio" aria-checked="${method === 'card'}" data-action="pay-method" data-method="card">카드<small>+${CARD_SURCHARGE_PERCENT}% 가산</small></button>
      </div>
      <label class="field"><span>할인 금액(원)</span>
        <input id="discount" data-input="discount" inputmode="numeric" autocomplete="off" placeholder="0" value="${esc(discountText)}">
      </label>
      <div id="pay-summary">${paymentSummary(base, method, discountText)}</div>
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
      <td>${esc(l.name)}${l.startedAt ? ` <small class="muted">${fmtTime(l.startedAt)}~</small>` : ''}</td>
      <td class="num">${won(l.unitPrice)} × ${l.qty}${l.kind === 'room' || l.serviceId ? '시간' : ''}</td>
      <td class="num">${won(l.subtotal)}</td></tr>`).join('')}
  </tbody></table>`;
}

function historySection() {
  const list = [...state.payments].reverse();
  return `<section class="card">
    <h3>결제 내역 ${list.length ? `(${list.length}건)` : ''}</h3>
    ${list.length ? '' : '<p class="muted">이번 영업일 결제가 아직 없습니다.</p>'}
    ${list.map((p) => `<details class="payment">
      <summary>
        <span>${fmtTime(p.paidAt)} · ${esc(p.roomName)}</span>
        <span class="badge ${p.method}">${METHOD_LABELS[p.method]}</span>
        <b>${won(p.amount)}</b>
      </summary>
      ${linesTable(p.lines)}
      <dl class="sum">
        <div><dt>판매액</dt><dd>${won(p.base)}</dd></div>
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
  return `
    <div class="big-total"><span>총매출(받은 금액)</span><b>${won(r.net_total)}</b></div>
    <dl class="sum">
      <div><dt>현금</dt><dd>${won(r.cash_total)}</dd></div>
      <div><dt>카드</dt><dd>${won(r.card_total)}</dd></div>
    </dl>
    <h4>매상 구조</h4>
    <dl class="sum">
      <div><dt>룸 이용</dt><dd>${won(cat.room)}</dd></div>
      <div><dt>주류</dt><dd>${won(cat.liquor)}</dd></div>
      <div><dt>기타 서비스</dt><dd>${won(cat.service)}</dd></div>
      <div class="sub"><dt>판매액 합계</dt><dd>${won(r.gross_sales)}</dd></div>
      <div><dt>카드 가산</dt><dd>+${won(r.card_surcharge_total)}</dd></div>
      <div><dt>할인</dt><dd>−${won(r.discount_total)}</dd></div>
      <div class="grand"><dt>받은 금액</dt><dd>${won(r.net_total)}</dd></div>
    </dl>
    <h4>룸별 매상</h4>
    ${(r.by_room || []).length
      ? `<dl class="sum">${r.by_room.map((x) => `<div><dt>${esc(x.roomName)} (${x.count}건)</dt><dd>${won(x.net)}</dd></div>`).join('')}</dl>`
      : '<p class="muted">없음</p>'}
    ${(r.by_item || []).length ? `<details><summary>품목별 판매</summary>
      <table class="lines"><tbody>${r.by_item.map((x) => `<tr><td>${esc(x.name)}</td><td class="num">${x.qty}</td><td class="num">${won(x.sales)}</td></tr>`).join('')}</tbody></table>
    </details>` : ''}`;
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
    ${historySection()}`;
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
        <span class="cal-d">${Number(date.slice(8))}</span>${e ? `<span class="cal-amt">${compactWon(e.net)}</span>` : ''}
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
    <details class="card fold" data-fold="basic" ${ui.basicOpen ? 'open' : ''}>
      <summary><h3>기본 정보</h3><span class="muted">${esc(d.storeName || '매장명 없음')} · ${esc(d.managerName || '관리자 미입력')} · PIN ${d.pin ? '입력됨' : '없음'}</span></summary>
      <label class="field"><span>매장명</span>${input('storeName', d.storeName, 'autocomplete="off"')}</label>
      <label class="field"><span>관리자 이름 (마감·설정 변경 기록용)</span>${input('managerName', d.managerName, 'autocomplete="off"')}</label>
      <label class="field"><span>매장 PIN (서버 저장용)</span>${input('pin', d.pin, 'type="password" autocomplete="off"')}</label>
      <label class="field"><span>영업일 기준 시각 (0~23시, 이 시각 이전에 시작한 영업은 전날 매출. 기본 12)</span>${input('dayCutoffHour', d.dayCutoffHour, 'inputmode="numeric"')}</label>
    </details>
    <section class="card">
      <h3>룸 요금</h3>
      ${d.rooms.map((r, i) => `<div class="grid-2">
        <label class="field"><span>룸 이름</span>${input(`rooms.${i}.name`, r.name)}</label>
        <label class="field"><span>시간당 요금(원)</span>${input(`rooms.${i}.hourlyRate`, r.hourlyRate, 'inputmode="numeric"')}</label>
      </div>`).join('')}
    </section>
    <section class="card">
      <h3>판매 품목</h3>
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
    </section>
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
    state.sessions[id] = { id: newId(), startedAt: now, hours: 0, quantities: {}, paidHours: 0, paidQuantities: {}, guests: 0, declined: 0, services: [] };
    if (!state.businessDay.openedAt) state.businessDay.openedAt = now;
    ui.roomId = id;
    commit();
  },
  'open-room': (el) => {
    ui.roomId = el.dataset.room;
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
    state.sessions[room.id] = null;
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
  'open-payment': () => {
    ui.payment = { roomId: ui.roomId, method: 'cash', discountText: '', endAfter: false };
    render();
  },
  'end-room': () => {
    const room = roomById(ui.roomId);
    const s = state.sessions[room.id];
    if (balanceOf(room, s) > 0) {
      ui.payment = { roomId: room.id, method: 'cash', discountText: '', endAfter: true };
      render();
      return;
    }
    if (!confirm(`${room.name}을(를) 종료할까요?\n다음 손님은 [시작]을 눌러 새로 시작합니다.`)) return;
    state.sessions[room.id] = null;
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

function updateSession(change) {
  const s = state.sessions[ui.roomId];
  const next = change(s);
  if (next === s) return;
  state.sessions[ui.roomId] = next;
  commit();
}

const updateCount = (key, delta) => updateSession((s) => changeCount(s, key, delta));

function confirmPayment() {
  const { roomId, method, discountText, endAfter } = ui.payment;
  const room = roomById(roomId);
  const s = state.sessions[roomId];
  const lines = unpaidLines(s, room, state.settings.items);
  const base = sumLines(lines);
  if (base === 0) return;
  let result;
  try {
    result = calcPayment(base, method, parseWon(discountText));
  } catch (e) {
    alert(e.message);
    return;
  }
  state.payments.push({
    id: newId(),
    roomId,
    roomName: room.name,
    sessionId: s.id,
    paidAt: new Date().toISOString(),
    method,
    lines,
    coveredBase: base,
    ...result,
  });
  state.sessions[roomId] = markSessionPaid(s);
  ui.payment = null;
  ui.notice = `${room.name} ${METHOD_LABELS[method]} ${won(result.amount)} 결제했습니다.`;
  if (endAfter) {
    state.sessions[roomId] = null;
    ui.roomId = null;
    ui.notice += ' 룸을 종료했습니다.';
  }
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
  });
  const empty = record.payment_count === 0 ? '\n\n※ 이번 영업일에 결제가 없습니다.' : '';
  const ok = confirm(
    `${record.business_date} 영업을 마감합니다.\n결제 ${record.payment_count}건 · 총매출 ${won(record.net_total)}${empty}\n\n` +
      '마감하면 서버에 저장하고 새 영업일을 시작합니다.',
  );
  if (!ok) return;

  // 업로드 전에 휴대폰에 먼저 보관해, 업로드가 실패해도 기록을 잃지 않고 재시도한다.
  state.pendingUploads = [...state.pendingUploads.filter((p) => p.id !== record.id), record];
  state.closeHistory = addCloseHistory(state.closeHistory, record);
  state.payments = [];
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

function onInput(e) {
  const el = e.target;
  if (el.dataset.input === 'discount') {
    // 입력 중 포커스를 잃지 않도록 합계 부분만 다시 그린다.
    ui.payment.discountText = el.value;
    const { roomId, method } = ui.payment;
    const base = sumLines(unpaidLines(state.sessions[roomId], roomById(roomId), state.settings.items));
    document.getElementById('pay-summary').innerHTML = paymentSummary(base, method, el.value);
    document.getElementById('confirm-payment').disabled = Number.isNaN(parseWon(el.value)) || !!document.querySelector('#pay-summary .error');
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

// toggle 이벤트는 버블링되지 않아 capture로 받는다. 다시 그려도 접힘 상태를 유지한다.
app.addEventListener(
  'toggle',
  (e) => {
    if (e.target.dataset?.fold === 'basic') ui.basicOpen = e.target.open;
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

render();
syncSettings().then(() => uploadPending());
