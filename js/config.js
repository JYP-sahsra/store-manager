// Supabase 연결 정보 (Project Settings → API).
// publishable(anon) key만 넣는다. 공개되어도 되는 값이며, 데이터 보호는 DB의 RLS와 매장 PIN이 담당한다.
// service_role(secret) key는 절대 넣지 않는다.
// 둘 중 하나라도 비어 있으면 앱은 서버 없이(휴대폰 저장만으로) 동작한다.
export const SUPABASE_URL = 'https://iexqwgymdaqcyafncfbx.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_qoO14SBa3N9gDzQo2Ez98A_qcFSdDqe';
