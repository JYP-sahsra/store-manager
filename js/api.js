// Supabase RPC 호출. 테이블에 직접 접근하지 않고 PIN을 검사하는 DB 함수만 부른다(supabase/schema.sql).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const ERROR_MESSAGES = {
  invalid_pin: 'PIN이 맞지 않습니다. 설정에서 PIN을 확인해 주세요.',
  locked: 'PIN 오류가 많아 10분간 잠겼습니다. 잠시 후 다시 시도해 주세요.',
  pin_not_set: '서버에 매장 PIN이 설정되지 않았습니다. README의 "PIN 설정"을 확인해 주세요.',
};

export function isServerConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

async function rpc(name, args) {
  if (!isServerConfigured()) throw new Error('서버 연결 정보가 없습니다(js/config.js).');
  const headers = { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY };
  // 예전 형식(JWT) anon key는 Authorization 헤더도 필요하다. 새 publishable key(sb_...)는 apikey만 보낸다.
  if (!SUPABASE_ANON_KEY.startsWith('sb_')) headers.Authorization = `Bearer ${SUPABASE_ANON_KEY}`;

  let res;
  try {
    res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
  } catch {
    throw new Error('서버에 연결할 수 없습니다. 인터넷 연결을 확인해 주세요.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`서버 오류(${res.status}): ${body?.message || '응답을 읽을 수 없습니다'}`);
  if (body?.ok === false) throw new Error(ERROR_MESSAGES[body.error] || `서버가 요청을 거부했습니다: ${body.error}`);
  return body;
}

export const fetchSettings = (pin) => rpc('get_settings', { p_pin: pin });

export const saveSettings = (pin, data, by) => rpc('save_settings', { p_pin: pin, p_data: data, p_by: by || null });

export const submitDayClose = (pin, close) => rpc('submit_day_close', { p_pin: pin, p_close: close });

export const listDayCloses = (pin, from, to) => rpc('list_day_closes', { p_pin: pin, p_from: from, p_to: to });
