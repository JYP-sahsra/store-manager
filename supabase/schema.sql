-- 매장관리 앱 DB 스키마 (Supabase SQL Editor에서 전체 실행)
-- 다시 실행해도 안전하다(if not exists / create or replace).
--
-- 보호 방식
--  - 모든 테이블은 RLS를 켜고 정책을 만들지 않는다 → anon(앱)은 테이블에 직접 접근할 수 없다.
--  - 앱은 아래 RPC 함수만 호출한다. 함수는 매장 PIN을 검사한 뒤에만 읽고 쓴다.
--  - PIN은 bcrypt 해시로만 저장한다. 10분 안에 10회 틀리면 10분간 잠긴다.
--  - 함수는 오류를 raise하지 않고 {ok:false, error} 를 돌려준다(실패 기록이 롤백되지 않게).

create extension if not exists pgcrypto with schema extensions;

-- 매장 PIN (1행)
create table if not exists public.store_secret (
  id integer primary key default 1 check (id = 1),
  pin_hash text not null
);

-- PIN 실패 기록 (잠금 판단용)
create table if not exists public.pin_failures (
  id bigserial primary key,
  failed_at timestamptz not null default now()
);

-- 가격 설정 (1행, 앱의 settings 객체를 그대로 저장)
create table if not exists public.store_settings (
  id integer primary key default 1 check (id = 1),
  data jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

-- 일 마감 기록. id는 휴대폰에서 만든 영업일 id(uuid)라 다시 올려도 중복되지 않는다.
-- 금액은 모두 원(KRW) 정수.
create table if not exists public.day_closes (
  id uuid primary key,
  business_date date not null,                 -- 영업일(영업 시작 시각 기준, 기기 현지 시각)
  opened_at timestamptz,                       -- 영업 시작(첫 룸 시작) 시각, 결제 없는 날은 null
  closed_at timestamptz not null,
  closed_by text,                              -- 마감한 관리자 이름
  gross_sales integer not null,                -- 판매액 합계(할인·카드 가산 전)
  discount_total integer not null,
  card_surcharge_total integer not null,       -- 카드 10% 가산 합계
  net_total integer not null,                  -- 받은 금액 합계 = 총매출
  cash_total integer not null,
  card_total integer not null,
  payment_count integer not null,
  by_room jsonb not null default '[]'::jsonb,      -- [{roomId, roomName, base, net, count}]
  by_category jsonb not null default '{}'::jsonb,  -- {room, liquor, service} 판매액
  by_item jsonb not null default '[]'::jsonb,      -- [{kind, name, unitPrice, qty, sales}]
  payments jsonb not null default '[]'::jsonb,     -- 결제 건별 상세
  uploaded_at timestamptz not null default now()
);
create index if not exists day_closes_business_date_idx on public.day_closes (business_date);

alter table public.store_secret enable row level security;
alter table public.pin_failures enable row level security;
alter table public.store_settings enable row level security;
alter table public.day_closes enable row level security;
revoke all on public.store_secret, public.pin_failures, public.store_settings, public.day_closes
  from anon, authenticated;

-- PIN 검사: 'ok' | 'invalid_pin' | 'locked' | 'pin_not_set'
create or replace function public._pin_status(p_pin text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
begin
  select pin_hash into v_hash from store_secret where id = 1;
  if v_hash is null then
    return 'pin_not_set';
  end if;
  if (select count(*) from pin_failures where failed_at > now() - interval '10 minutes') >= 10 then
    return 'locked';
  end if;
  if v_hash = crypt(coalesce(p_pin, ''), v_hash) then
    return 'ok';
  end if;
  insert into pin_failures default values;
  delete from pin_failures where failed_at < now() - interval '1 day';
  return 'invalid_pin';
end;
$$;

create or replace function public.get_settings(p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
  v_row store_settings;
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  select * into v_row from store_settings where id = 1;
  return jsonb_build_object(
    'ok', true,
    'settings', v_row.data,
    'updated_at', v_row.updated_at,
    'updated_by', v_row.updated_by
  );
end;
$$;

create or replace function public.save_settings(p_pin text, p_data jsonb, p_by text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
  v_updated_at timestamptz;
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  if jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('ok', false, 'error', 'invalid_settings');
  end if;
  insert into store_settings (id, data, updated_at, updated_by)
  values (1, p_data, now(), p_by)
  on conflict (id) do update
    set data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  returning updated_at into v_updated_at;
  return jsonb_build_object('ok', true, 'updated_at', v_updated_at);
end;
$$;

create or replace function public.submit_day_close(p_pin text, p_close jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
  v_id uuid;
  v_date date;
  v_same_date integer;
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  v_id := (p_close->>'id')::uuid;
  v_date := (p_close->>'business_date')::date;

  insert into day_closes (
    id, business_date, opened_at, closed_at, closed_by,
    gross_sales, discount_total, card_surcharge_total, net_total, cash_total, card_total, payment_count,
    by_room, by_category, by_item, payments, uploaded_at
  ) values (
    v_id, v_date, (p_close->>'opened_at')::timestamptz, (p_close->>'closed_at')::timestamptz, p_close->>'closed_by',
    (p_close->>'gross_sales')::integer, (p_close->>'discount_total')::integer,
    (p_close->>'card_surcharge_total')::integer, (p_close->>'net_total')::integer,
    (p_close->>'cash_total')::integer, (p_close->>'card_total')::integer, (p_close->>'payment_count')::integer,
    coalesce(p_close->'by_room', '[]'::jsonb), coalesce(p_close->'by_category', '{}'::jsonb),
    coalesce(p_close->'by_item', '[]'::jsonb), coalesce(p_close->'payments', '[]'::jsonb), now()
  )
  on conflict (id) do update set
    business_date = excluded.business_date, opened_at = excluded.opened_at,
    closed_at = excluded.closed_at, closed_by = excluded.closed_by,
    gross_sales = excluded.gross_sales, discount_total = excluded.discount_total,
    card_surcharge_total = excluded.card_surcharge_total, net_total = excluded.net_total,
    cash_total = excluded.cash_total, card_total = excluded.card_total, payment_count = excluded.payment_count,
    by_room = excluded.by_room, by_category = excluded.by_category, by_item = excluded.by_item,
    payments = excluded.payments, uploaded_at = excluded.uploaded_at;

  select count(*) into v_same_date from day_closes where business_date = v_date and id <> v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'same_date_count', v_same_date);
end;
$$;

-- 지난 마감 목록(결제 건별 상세 제외, 최근 100건)
create or replace function public.list_day_closes(p_pin text, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
  v_rows jsonb;
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  select coalesce(jsonb_agg(to_jsonb(t) - 'payments' order by t.business_date desc, t.closed_at desc), '[]'::jsonb)
    into v_rows
  from (
    select * from day_closes
    where business_date between p_from and p_to
    order by business_date desc, closed_at desc
    limit 100
  ) t;
  return jsonb_build_object('ok', true, 'closes', v_rows);
end;
$$;

-- 실행 권한: 앱(anon)은 공개 함수 4개만 호출할 수 있다.
revoke all on function public._pin_status(text) from public, anon, authenticated;
revoke all on function public.get_settings(text) from public;
revoke all on function public.save_settings(text, jsonb, text) from public;
revoke all on function public.submit_day_close(text, jsonb) from public;
revoke all on function public.list_day_closes(text, date, date) from public;
grant execute on function public.get_settings(text) to anon, authenticated;
grant execute on function public.save_settings(text, jsonb, text) to anon, authenticated;
grant execute on function public.submit_day_close(text, jsonb) to anon, authenticated;
grant execute on function public.list_day_closes(text, date, date) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- PIN 설정 (아래 문장의 '여기에-PIN' 부분만 바꿔 따로 실행. 6자리 이상 권장)
-- PIN을 바꿀 때도 같은 문장을 다시 실행한다.
--
-- insert into public.store_secret (id, pin_hash)
-- values (1, extensions.crypt('여기에-PIN', extensions.gen_salt('bf')))
-- on conflict (id) do update set pin_hash = excluded.pin_hash;
-- ─────────────────────────────────────────────────────────────
