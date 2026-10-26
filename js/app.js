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
} from './storage.js';
import * as api from './api.js';

const app = document.getElementById('app');
const loaded = loadState(localStorage);
let state = loaded.state;

const ui = {
  tab: 'rooms',
  roomId: null, // 상세를 보고 있는 룸
  payment: null, // { roomId, method, discountText, endAfter }
  draft: null, // 설정 화면 편집 중인 값
  notice: loaded.warning,
  pastCloses: null, // { source: 'server' | 'local', list }
  busy: false,
};

const TABS = [
  { id: 'rooms', label: '룸' },
  { id: 'history', label: '결제내역' },
  { id: 'close', label: '마감' },
  { id: 'settings', label: '설정' },
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
const fmtDateTime = (iso) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(iso)}`;
};
function elapsedText(iso) {
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  const h = Math.floor(m / 60);
  return h ? `${h}시간 ${m % 60}분` : `${m}분`;
}

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
  const views = { rooms: roomsView, history: historyView, close: closeView, settings: settingsView };
  app.innerHTML = `
    <header class="topbar">
      <h1>${esc(state.settings.storeName || '매장관리')}</h1>
      <span class="muted">${esc(currentBusinessDate())} 영업</span>
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
  return `<div class="room-list">${state.settings.rooms.map(roomCard).join('')}</div>
    ${state.settings.items.length ? '' : '<p class="empty">설정 탭에서 판매 품목과 룸 요금을 먼저 입력해 주세요.</p>'}`;
}

function roomCard(room) {
  const s = state.sessions[room.id];
  if (!s) {
    return `<div class="card room-card">
      <div class="room-head"><h2>${esc(room.name)}</h2><span class="badge">대기</span></div>
      <button class="btn primary block" data-action="start-room" data-room="${room.id}">시작</button>
    </div>`;
  }
  const balance = balanceOf(room, s);
  return `<button class="card room-card active" data-action="open-room" data-room="${room.id}">
    <div class="room-head"><h2>${esc(room.name)}</h2><span class="badge on">이용 중</span></div>
    <p class="muted">시작 ${fmtTime(s.startedAt)} · ${elapsedText(s.startedAt)} 경과 · ${s.hours}시간</p>
    <div class="room-money">
      <span>결제 완료 <b>${won(sessionPaid(s))}</b></span>
      <span>미결제 <b class="${balance ? 'balance' : ''}">${won(balance)}</b></span>
    </div>
  </button>`;
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

function roomDetailView(roomId) {
  const room = roomById(roomId);
  const s = state.sessions[roomId];
  const items = state.settings.items.filter((i) => i.active || (s.quantities[i.id] || 0) > 0);
  const groups = ['liquor', 'service']
    .map((cat) => {
      const list = items.filter((i) => i.category === cat);
      if (!list.length) return '';
      return `<section class="card"><h3>${CATEGORY_LABELS[cat]}</h3>
        ${list.map((i) => counterRow({ label: i.name, sub: won(i.price), key: i.id, qty: s.quantities[i.id] || 0, paid: s.paidQuantities[i.id] || 0 })).join('')}
      </section>`;
    })
    .join('');
  const balance = balanceOf(room, s);
  return `
    <div class="detail-head">
      <button class="link" data-action="back">‹ 룸 목록</button>
      <h2>${esc(room.name)}</h2>
      <p class="muted">시작 ${fmtTime(s.startedAt)} · ${elapsedText(s.startedAt)} 경과</p>
    </div>
    <section class="card"><h3>룸 이용</h3>
      ${counterRow({ label: '이용 시간', sub: `시간당 ${won(room.hourlyRate)}`, key: HOURS_KEY, qty: s.hours, paid: s.paidHours })}
    </section>
    ${groups || '<p class="empty">판매 중인 품목이 없습니다. 설정 탭에서 추가해 주세요.</p>'}
    <div class="detail-footer">
      <div class="room-money">
        <span>결제 완료 <b>${won(sessionPaid(s))}</b></span>
        <span>미결제 <b class="${balance ? 'balance' : ''}">${won(balance)}</b></span>
      </div>
      <div class="actions">
        <button class="btn" data-action="end-room">종료</button>
        <button class="btn primary" data-action="open-payment" ${balance > 0 ? '' : 'disabled'}>결제</button>
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
  const lines = unpaidLines(state.sessions[roomId], room, state.settings.items);
  const base = sumLines(lines);
  return `<div class="sheet-backdrop">
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pay-title">
      <h2 id="pay-title">${esc(room.name)} 결제</h2>
      ${endAfter ? '<p class="warn">미결제 금액이 있습니다. 결제하면 룸을 종료합니다.</p>' : ''}
      ${linesTable(lines)}
      <div class="segmented" role="radiogroup" aria-label="결제수단">
        <button role="radio" aria-checked="${method === 'cash'}" data-action="pay-method" data-method="cash">현금</button>
        <button role="radio" aria-checked="${method === 'card'}" data-action="pay-method" data-method="card">카드 (+${CARD_SURCHARGE_PERCENT}%)</button>
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
    ${lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${won(l.unitPrice)} × ${l.qty}</td><td class="num">${won(l.subtotal)}</td></tr>`).join('')}
  </tbody></table>`;
}

function historyView() {
  const list = [...state.payments].reverse();
  if (!list.length) return '<p class="empty">이번 영업일 결제 내역이 없습니다.</p>';
  const total = list.reduce((a, p) => a + p.amount, 0);
  return `<div class="card summary-line"><span>결제 ${list.length}건</span><b>${won(total)}</b></div>
    ${list.map((p) => `<details class="card payment">
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
    </details>`).join('')}`;
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

function closeView() {
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
  const past = ui.pastCloses;
  return `
    <section class="card">
      <h3>${esc(preview.business_date)} 영업 요약</h3>
      <p class="muted">${state.businessDay.openedAt ? `영업 시작 ${fmtDateTime(state.businessDay.openedAt)} · ` : ''}결제 ${preview.payment_count}건</p>
      ${closeBreakdown(preview)}
    </section>
    ${active.length ? `<p class="warn">이용 중인 룸이 있어 마감할 수 없습니다: ${active.map((r) => esc(r.name)).join(', ')}</p>` : ''}
    <button class="btn primary block" data-action="close-day" ${active.length || ui.busy ? 'disabled' : ''}>일 마감 (백업 저장 + 서버 업로드)</button>
    ${pending.length ? `<section class="card warn-card">
      <p>서버에 올리지 못한 마감 ${pending.length}건이 휴대폰에 있습니다: ${pending.map((p) => esc(p.business_date)).join(', ')}</p>
      <button class="btn block" data-action="retry-upload" ${ui.busy ? 'disabled' : ''}>다시 업로드</button>
    </section>` : ''}
    <section class="card">
      <div class="row-between"><h3>지난 마감</h3>
        <button class="btn small" data-action="load-past" ${ui.busy ? 'disabled' : ''}>불러오기</button></div>
      ${past ? pastClosesList(past) : '<p class="muted">불러오기를 누르면 최근 60일 마감 기록을 봅니다.</p>'}
    </section>`;
}

function pastClosesList({ source, list }) {
  const note = source === 'server' ? '서버 기록' : '이 휴대폰의 기록 (서버 미연결)';
  if (!list.length) return `<p class="muted">${note}: 없음</p>`;
  return `<p class="muted">${note}</p>
    ${list.map((r) => `<details class="past">
      <summary><span>${esc(r.business_date)}</span><span class="muted">${esc(r.closed_by || '')}</span><b>${won(r.net_total)}</b></summary>
      <p class="muted">마감 ${fmtDateTime(r.closed_at)} · 결제 ${r.payment_count}건</p>
      ${closeBreakdown(r)}
    </details>`).join('')}`;
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
    <section class="card">
      <h3>기본 정보</h3>
      <label class="field"><span>매장명</span>${input('storeName', d.storeName, 'autocomplete="off"')}</label>
      <label class="field"><span>관리자 이름 (마감·설정 변경 기록용)</span>${input('managerName', d.managerName, 'autocomplete="off"')}</label>
      <label class="field"><span>매장 PIN (서버 저장용)</span>${input('pin', d.pin, 'type="password" autocomplete="off"')}</label>
      <label class="field"><span>영업일 기준 시각 (0~23시)</span>${input('dayCutoffHour', d.dayCutoffHour, 'inputmode="numeric"')}</label>
    </section>
    <section class="card">
      <h3>룸 요금</h3>
      ${d.rooms.map((r, i) => `<div class="grid-2">
        <label class="field"><span>룸 이름</span>${input(`rooms.${i}.name`, r.name)}</label>
        <label class="field"><span>시간당 요금(원)</span>${input(`rooms.${i}.hourlyRate`, r.hourlyRate, 'inputmode="numeric"')}</label>
      </div>`).join('')}
    </section>
    <section class="card">
      <h3>판매 품목</h3>
      ${d.items.length ? '' : '<p class="muted">품목이 없습니다.</p>'}
      ${d.items.map((it, i) => `<div class="item-edit">
        <label class="field grow"><span>이름</span>${input(`items.${i}.name`, it.name, 'autocomplete="off"')}</label>
        <label class="field"><span>분류</span>
          <select data-input="draft" data-path="items.${i}.category">
            <option value="liquor" ${it.category === 'liquor' ? 'selected' : ''}>주류</option>
            <option value="service" ${it.category === 'service' ? 'selected' : ''}>기타 서비스</option>
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
      <p class="muted">일 마감 때 자동으로 백업 파일을 저장합니다. 휴대폰을 바꿀 때는 백업 파일을 가져오세요.</p>
      <div class="actions">
        <button class="btn" data-action="export-backup">백업 내보내기</button>
        <label class="btn file-btn">백업 가져오기<input type="file" accept="application/json,.json" data-input="import"></label>
      </div>
    </section>`;
}

// ── 동작 ─────────────────────────────────────────────

const actions = {
  'dismiss-notice': () => notify(''),
  tab: (el) => {
    if (ui.tab === el.dataset.tab && el.dataset.tab === 'rooms') ui.roomId = null;
    ui.tab = el.dataset.tab;
    render();
  },
  'start-room': (el) => {
    const now = new Date().toISOString();
    const id = el.dataset.room;
    state.sessions[id] = { id: newId(), startedAt: now, hours: 0, quantities: {}, paidHours: 0, paidQuantities: {} };
    if (!state.businessDay.openedAt) state.businessDay.openedAt = now;
    ui.roomId = id;
    commit();
  },
  'open-room': (el) => {
    ui.roomId = el.dataset.room;
    render();
  },
  back: () => {
    ui.roomId = null;
    render();
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
  'load-past': loadPastCloses,
  'add-item': () => {
    ui.draft.items.push({ id: newId(), name: '', category: 'liquor', price: '', active: true });
    render();
    const inputs = app.querySelectorAll('.item-edit input[data-path$=".name"]');
    inputs[inputs.length - 1]?.focus();
  },
  'delete-item': (el) => {
    const item = ui.draft.items[Number(el.dataset.index)];
    const inUse = Object.values(state.sessions).some((s) => s && (s.quantities[item.id] || 0) > 0);
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

function updateCount(key, delta) {
  const s = state.sessions[ui.roomId];
  const next = changeCount(s, key, delta);
  if (next === s) return;
  state.sessions[ui.roomId] = next;
  commit();
}

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
      '마감하면 백업 파일을 저장하고 서버에 업로드한 뒤 새 영업일을 시작합니다.',
  );
  if (!ok) return;

  // 백업 파일을 먼저 남기고, 업로드는 실패해도 휴대폰에 보관한 뒤 재시도한다.
  const closedAt = new Date(record.closed_at);
  downloadFile(
    `store-close-${record.business_date}-${pad(closedAt.getHours())}${pad(closedAt.getMinutes())}.json`,
    exportBackup(state, record),
  );
  state.pendingUploads = [...state.pendingUploads.filter((p) => p.id !== record.id), record];
  state.closeHistory = addCloseHistory(state.closeHistory, record);
  state.payments = [];
  state.businessDay = { id: newId(), openedAt: null };
  ui.pastCloses = null;
  ui.notice = `${record.business_date} 마감을 휴대폰에 저장했습니다.`;
  commit();
  await uploadPending();
}

async function uploadPending() {
  if (ui.busy || !state.pendingUploads.length) return;
  if (!api.isServerConfigured()) {
    notify(`${ui.notice} 서버가 설정되지 않아 업로드하지 않았습니다(마감 탭에 보관).`.trim());
    return;
  }
  if (!state.pin) {
    notify('서버 업로드에 PIN이 필요합니다. 설정 탭에서 매장 PIN을 입력해 주세요.');
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
    ui.notice = `마감 업로드 실패: ${error} (휴대폰에 보관 중이며 마감 탭에서 다시 올릴 수 있습니다)`;
  } else {
    ui.notice = `마감 ${done.length}건을 서버에 저장했습니다.${sameDate ? ' 같은 날짜의 마감이 이미 있어 별도 건으로 저장했습니다.' : ''}`;
  }
  commit();
}

async function loadPastCloses() {
  if (!api.isServerConfigured() || !state.pin) {
    ui.pastCloses = { source: 'local', list: state.closeHistory };
    render();
    return;
  }
  ui.busy = true;
  render();
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 60);
  try {
    const r = await api.listDayCloses(state.pin, businessDate(from), businessDate(to));
    ui.pastCloses = { source: 'server', list: r.closes };
  } catch (e) {
    ui.pastCloses = { source: 'local', list: state.closeHistory };
    ui.notice = `서버에서 불러오지 못해 휴대폰 기록을 보여 줍니다: ${e.message}`;
  }
  ui.busy = false;
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
  ui.pastCloses = null;
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
  if (e.target.dataset.input === 'import') importBackup(e.target);
  else onInput(e);
});

// 경과 시간 표시를 갱신한다. 입력 중이거나 결제 화면이 열려 있으면 건너뛴다.
setInterval(() => {
  if (ui.tab === 'rooms' && !ui.payment && !document.activeElement?.matches('input, select')) render();
}, 30000);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker 등록 실패', e));
}

render();
syncSettings().then(() => uploadPending());
