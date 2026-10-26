// 휴대폰(localStorage) 저장, 기본값, 데이터 검증, 백업 파일 처리.
// 데이터 구조는 CLAUDE.md의 "데이터 계약"과 맞춰 유지한다.

export const STORAGE_KEY = 'storeManager.v1';
export const STATE_VERSION = 1;
export const ROOM_IDS = ['room1', 'room2', 'room3'];
export const ITEM_CATEGORIES = ['liquor', 'service'];
const BACKUP_APP = 'store-manager';
const CLOSE_HISTORY_LIMIT = 60;

// UUID v4. http(비보안) 접속에서는 crypto.randomUUID가 없어 직접 만든다.
export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function defaultSettings() {
  return {
    storeName: '',
    rooms: ROOM_IDS.map((id, i) => ({ id, name: `${i + 1}번 룸`, hourlyRate: 0 })),
    items: [],
    dayCutoffHour: 0,
    updatedAt: null,
    updatedBy: null,
  };
}

export function defaultState() {
  return {
    version: STATE_VERSION,
    pin: '',
    managerName: '',
    settings: defaultSettings(),
    settingsDirty: false,
    settingsServerUpdatedAt: null,
    businessDay: { id: newId(), openedAt: null },
    sessions: Object.fromEntries(ROOM_IDS.map((id) => [id, null])),
    payments: [],
    pendingUploads: [],
    closeHistory: [],
  };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;
const nonNegInt = (v, fallback) => (isNonNegInt(v) ? v : fallback);

function normalizeCounts(raw) {
  const out = {};
  if (!isObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (isNonNegInt(v)) out[k] = v;
  return out;
}

export function normalizeSettings(raw) {
  const d = defaultSettings();
  if (!isObject(raw)) return d;
  const rooms = Array.isArray(raw.rooms) ? raw.rooms : [];
  return {
    storeName: str(raw.storeName),
    rooms: ROOM_IDS.map((id, i) => {
      const r = rooms.find((x) => isObject(x) && x.id === id);
      return { id, name: str(r?.name) || d.rooms[i].name, hourlyRate: nonNegInt(r?.hourlyRate, 0) };
    }),
    items: (Array.isArray(raw.items) ? raw.items : [])
      .filter((i) => isObject(i) && str(i.id) && str(i.name))
      .map((i) => ({
        id: i.id,
        name: i.name,
        category: ITEM_CATEGORIES.includes(i.category) ? i.category : 'service',
        price: nonNegInt(i.price, 0),
        active: i.active !== false,
      })),
    dayCutoffHour: Number.isInteger(raw.dayCutoffHour) && raw.dayCutoffHour >= 0 && raw.dayCutoffHour <= 23
      ? raw.dayCutoffHour
      : 0,
    updatedAt: str(raw.updatedAt) || null,
    updatedBy: str(raw.updatedBy) || null,
  };
}

function normalizeSession(raw) {
  if (!isObject(raw)) return null;
  return {
    id: str(raw.id) || newId(),
    startedAt: str(raw.startedAt) || new Date().toISOString(),
    hours: nonNegInt(raw.hours, 0),
    quantities: normalizeCounts(raw.quantities),
    paidHours: nonNegInt(raw.paidHours, 0),
    paidQuantities: normalizeCounts(raw.paidQuantities),
  };
}

// 형식이 맞지 않으면 Error를 던진다. 빠진 선택 필드는 기본값으로 채운다.
export function normalizeState(raw) {
  if (!isObject(raw)) throw new Error('데이터 형식이 올바르지 않습니다');
  if (raw.version !== STATE_VERSION) throw new Error(`지원하지 않는 데이터 버전입니다: ${raw.version}`);
  for (const key of ['payments', 'pendingUploads', 'closeHistory']) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new Error(`${key} 형식이 올바르지 않습니다`);
  }
  const base = defaultState();
  const sessions = {};
  for (const id of ROOM_IDS) sessions[id] = normalizeSession(raw.sessions?.[id]);
  return {
    version: STATE_VERSION,
    pin: str(raw.pin),
    managerName: str(raw.managerName),
    settings: normalizeSettings(raw.settings),
    settingsDirty: raw.settingsDirty === true,
    settingsServerUpdatedAt: str(raw.settingsServerUpdatedAt) || null,
    businessDay: isObject(raw.businessDay) && str(raw.businessDay.id)
      ? { id: raw.businessDay.id, openedAt: str(raw.businessDay.openedAt) || null }
      : base.businessDay,
    sessions,
    payments: raw.payments ?? [],
    pendingUploads: raw.pendingUploads ?? [],
    closeHistory: (raw.closeHistory ?? []).slice(0, CLOSE_HISTORY_LIMIT),
  };
}

export function loadState(storage) {
  let raw;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { state: defaultState(), warning: '이 브라우저에서 저장소를 사용할 수 없어 데이터가 저장되지 않습니다.' };
  }
  if (!raw) return { state: defaultState(), warning: '' };
  try {
    return { state: normalizeState(JSON.parse(raw)), warning: '' };
  } catch (e) {
    // 원본을 지우지 않고 별도 키에 남겨 복구할 수 있게 한다.
    const corruptKey = `${STORAGE_KEY}.corrupt.${Date.now()}`;
    try {
      storage.setItem(corruptKey, raw);
    } catch {
      /* 보관 실패는 아래 경고로 대신 알린다 */
    }
    return {
      state: defaultState(),
      warning: `저장된 데이터를 읽지 못해 새로 시작했습니다(${e.message}). 원본은 ${corruptKey} 키에 보관했습니다.`,
    };
  }
}

export function saveState(state, storage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function addCloseHistory(history, record) {
  const { payments, ...summary } = record;
  return [summary, ...history.filter((h) => h.id !== record.id)].slice(0, CLOSE_HISTORY_LIMIT);
}

// 백업 파일에는 PIN을 넣지 않는다.
export function exportBackup(state, close = null) {
  const { pin, ...rest } = state;
  return JSON.stringify({ app: BACKUP_APP, exportedAt: new Date().toISOString(), state: rest, close }, null, 2);
}

export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('백업 파일이 JSON 형식이 아닙니다.');
  }
  if (!isObject(data) || data.app !== BACKUP_APP || !isObject(data.state)) {
    throw new Error('이 앱의 백업 파일이 아닙니다.');
  }
  return normalizeState(data.state);
}

export function validateSettings(settings) {
  const errors = [];
  settings.rooms.forEach((r, i) => {
    const label = r.name || `${i + 1}번째 룸`;
    if (!r.name) errors.push(`${i + 1}번째 룸 이름을 입력해 주세요.`);
    if (!isNonNegInt(r.hourlyRate)) errors.push(`${label}: 시간당 요금은 0 이상의 숫자(원)로 입력해 주세요.`);
  });
  settings.items.forEach((item, i) => {
    const label = item.name || `${i + 1}번째 품목`;
    if (!item.name) errors.push(`${i + 1}번째 품목 이름을 입력해 주세요.`);
    if (!ITEM_CATEGORIES.includes(item.category)) errors.push(`${label}: 분류를 선택해 주세요.`);
    if (!isNonNegInt(item.price)) errors.push(`${label}: 가격은 0 이상의 숫자(원)로 입력해 주세요.`);
  });
  const h = settings.dayCutoffHour;
  if (!Number.isInteger(h) || h < 0 || h > 23) errors.push('영업일 기준 시각은 0~23 사이 숫자로 입력해 주세요.');
  return errors;
}

// 서버 설정을 받을 때, 이용 중인 룸이 쓰는 품목이 서버에서 빠졌으면 판매 중지 상태로 남긴다.
export function mergeServerSettings(local, server, sessions) {
  const next = normalizeSettings(server);
  const used = new Set();
  for (const s of Object.values(sessions)) {
    if (!s) continue;
    for (const [id, qty] of Object.entries(s.quantities)) if (qty > 0) used.add(id);
  }
  for (const item of local.items) {
    if (used.has(item.id) && !next.items.some((i) => i.id === item.id)) {
      next.items.push({ ...item, active: false });
    }
  }
  return next;
}
