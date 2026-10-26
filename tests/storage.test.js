import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY,
  defaultState,
  loadState,
  saveState,
  normalizeState,
  normalizeSettings,
  exportBackup,
  parseBackup,
  validateSettings,
  mergeServerSettings,
  addCloseHistory,
  newId,
} from '../js/storage.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}

test('처음 실행하면 룸 3개 기본값으로 시작한다', () => {
  const { state, warning } = loadState(memoryStorage());
  assert.equal(warning, '');
  assert.equal(state.settings.rooms.length, 3);
  assert.deepEqual(Object.keys(state.sessions), ['room1', 'room2', 'room3']);
  assert.equal(state.businessDay.openedAt, null);
});

test('저장 후 다시 읽으면 같은 데이터', () => {
  const storage = memoryStorage();
  const state = defaultState();
  state.settings.items.push({ id: 'beer', name: '맥주', category: 'liquor', price: 8000, active: true });
  saveState(state, storage);
  assert.deepEqual(loadState(storage).state, state);
});

test('손상된 데이터는 원본을 별도 키에 보관하고 새로 시작한다', () => {
  const storage = memoryStorage({ [STORAGE_KEY]: '{not json' });
  const { state, warning } = loadState(storage);
  assert.match(warning, /읽지 못해/);
  assert.equal(state.payments.length, 0);
  const corruptKey = Object.keys(storage.data).find((k) => k.includes('.corrupt.'));
  assert.equal(storage.data[corruptKey], '{not json');
});

test('잘못된 수량과 가격은 정리하고, 빠진 필드는 채운다', () => {
  const s = normalizeState({
    version: 1,
    settings: { rooms: [{ id: 'room2', name: 'VIP', hourlyRate: -5 }], items: [{ id: 'x', name: '물', price: '1000' }] },
    sessions: { room1: { id: 's', startedAt: '2026-10-26T10:00:00Z', hours: 2, quantities: { x: 1, y: -1 } } },
  });
  assert.equal(s.settings.rooms[1].name, 'VIP');
  assert.equal(s.settings.rooms[1].hourlyRate, 0);
  assert.equal(s.settings.items[0].price, 0);
  assert.equal(s.settings.items[0].category, 'service');
  assert.deepEqual(s.sessions.room1.quantities, { x: 1 });
  assert.equal(s.sessions.room1.paidHours, 0);
  assert.deepEqual(s.sessions.room1.services, []); // 예전 데이터에는 서비스 목록이 없다
  assert.equal(s.sessions.room2, null);
  assert.deepEqual(s.payments, []);
});

test('시간제 서비스 정규화: 잘못된 항목은 버리고 시간은 0 이상 정수', () => {
  const s = normalizeState({
    version: 1,
    sessions: { room2: { id: 's', startedAt: '2026-10-26T12:00:00Z', services: [
      { id: 'a', itemId: 'svc', startedAt: '2026-10-26T12:10:00Z', hours: 2, paidHours: 1 },
      { id: 'b', itemId: 'svc', startedAt: '2026-10-26T12:20:00Z', hours: -3 },
      { itemId: '', startedAt: 'x' },
    ] } },
  });
  assert.deepEqual(s.sessions.room2.services.map((v) => [v.id, v.hours, v.paidHours]), [['a', 2, 1], ['b', 0, 0]]);
});

test('버전이 다르거나 결제 내역 형식이 틀리면 거부한다', () => {
  assert.throws(() => normalizeState({ version: 2 }), /버전/);
  assert.throws(() => normalizeState({ version: 1, payments: {} }), /payments/);
});

test('백업 파일에는 PIN이 없고, 다시 가져올 수 있다', () => {
  const state = defaultState();
  state.pin = 'secret-pin';
  state.managerName = '관리자A';
  const text = exportBackup(state, { id: 'c1' });
  assert.ok(!text.includes('secret-pin'));
  const restored = parseBackup(text);
  assert.equal(restored.managerName, '관리자A');
  assert.equal(restored.pin, '');
  assert.throws(() => parseBackup('{"app":"other","state":{}}'), /백업 파일이 아닙니다/);
  assert.throws(() => parseBackup('nope'), /JSON/);
});

test('영업일 기준 시각: 기본 12시, v1 설정의 0시는 12시로 옮기고 v2의 값은 유지', () => {
  assert.equal(defaultState().settings.dayCutoffHour, 12);
  assert.equal(normalizeSettings({ dayCutoffHour: 0 }).dayCutoffHour, 12);
  assert.equal(normalizeSettings({ dayCutoffHour: 6 }).dayCutoffHour, 6);
  assert.equal(normalizeSettings({ dayCutoffHour: 0, settingsVersion: 2 }).dayCutoffHour, 0);
  assert.equal(normalizeSettings({ dayCutoffHour: 0 }).settingsVersion, 2);
});

test('설정 검증: 이름, 가격, 기준 시각', () => {
  const s = defaultState().settings;
  assert.deepEqual(validateSettings(s), []);
  s.rooms[0].name = '';
  s.rooms[1].hourlyRate = Number.NaN;
  s.items.push({ id: 'a', name: '', category: 'liquor', price: 1000 });
  s.items.push({ id: 'b', name: '안주', category: 'food', price: -1 });
  s.dayCutoffHour = 24;
  assert.equal(validateSettings(s).length, 6);
});

test('서버 설정 적용 시 이용 중인 룸이 쓰는 품목은 판매 중지로 남긴다', () => {
  const local = defaultState().settings;
  local.items = [{ id: 'beer', name: '맥주', category: 'liquor', price: 8000, active: true }];
  const server = { ...local, items: [{ id: 'soju', name: '소주', category: 'liquor', price: 6000, active: true }] };
  const sessions = { room1: { quantities: { beer: 2 } }, room2: null, room3: null };
  const merged = mergeServerSettings(local, server, sessions);
  assert.deepEqual(merged.items.map((i) => [i.id, i.active]), [['soju', true], ['beer', false]]);
});

test('마감 기록 보관은 결제 상세를 빼고 같은 id는 덮어쓴다', () => {
  let h = addCloseHistory([], { id: 'a', net_total: 1, payments: [{}] });
  h = addCloseHistory(h, { id: 'a', net_total: 2, payments: [] });
  assert.deepEqual(h, [{ id: 'a', net_total: 2 }]);
});

test('newId는 UUID 형식', () => {
  assert.match(newId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
