// Supabase RPC 호출. 테이블에 직접 접근하지 않고 PIN을 검사하는 DB 함수만 부른다(supabase/schema.sql).
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const ERROR_MESSAGES = {
  invalid_pin: 'PIN이 맞지 않습니다. 설정에서 PIN을 확인해 주세요.',
  locked: 'PIN 오류가 많아 10분간 잠겼습니다. 잠시 후 다시 시도해 주세요.',
  pin_not_set: '서버에 매장 PIN이 설정되지 않았습니다. README의 "PIN 설정"을 확인해 주세요.',
  invalid_phone: '전화번호를 9자리 이상 숫자로 입력해 주세요.',
  invalid_name: '외상 고객 이름을 입력해 주세요.',
  invalid_entry: '외상 금액이 올바르지 않습니다.',
  over_balance: '상환 금액이 외상 잔액보다 큽니다. 명단을 새로 불러와 잔액을 확인해 주세요.',
  not_found: '외상 명단을 찾을 수 없습니다. 이미 삭제됐을 수 있습니다.',
  balance_remaining: '잔액이 남아 있어 삭제할 수 없습니다. 전부 상환한 뒤 삭제해 주세요.',
};

// 외상 장부 함수가 없으면(supabase/credit.sql 미실행) PostgREST가 404를 돌려준다.
const MISSING_FUNCTION = '외상 장부 서버 설정이 아직 없습니다. README의 "외상 장부 설정"대로 supabase/credit.sql을 실행해 주세요.';

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
  if (res.status === 404 && name.includes('credit')) throw new Error(MISSING_FUNCTION);
  if (!res.ok) throw new Error(`서버 오류(${res.status}): ${body?.message || '응답을 읽을 수 없습니다'}`);
  if (body?.ok === false) throw new Error(ERROR_MESSAGES[body.error] || `서버가 요청을 거부했습니다: ${body.error}`);
  return body;
}

export const fetchSettings = (pin) => rpc('get_settings', { p_pin: pin });

export const saveSettings = (pin, data, by) => rpc('save_settings', { p_pin: pin, p_data: data, p_by: by || null });

export const submitDayClose = (pin, close) => rpc('submit_day_close', { p_pin: pin, p_close: close });

export const listDayCloses = (pin, from, to) => rpc('list_day_closes', { p_pin: pin, p_from: from, p_to: to });

// 외상 장부(supabase/credit.sql)
export const listCreditAccounts = (pin, query) => rpc('list_credit_accounts', { p_pin: pin, p_query: query || '' });

export const getCreditAccount = (pin, accountId) => rpc('get_credit_account', { p_pin: pin, p_account_id: accountId });

export const addCreditEntry = (pin, entry) => rpc('add_credit_entry', { p_pin: pin, p_entry: entry });

export const deleteCreditAccount = (pin, accountId) =>
  rpc('delete_credit_account', { p_pin: pin, p_account_id: accountId });
