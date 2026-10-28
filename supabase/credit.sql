-- 외상 장부 (schema.sql을 먼저 실행한 뒤, Supabase SQL Editor에서 이 파일 전체를 실행)
-- 다시 실행해도 안전하다(if not exists / create or replace).
--
-- 규칙
--  - 같은 사람 = 같은 전화번호(숫자만 저장)
--  - 외상(issue)·상환(repay)을 하위 내역으로 쌓고, 잔액 = 외상 합계 − 상환 합계
--  - 상환은 잔액을 넘을 수 없다. 카드 상환은 paid_amount(받은 금액, 1.1배)만 다르고 장부는 amount만 차감
--  - 명단 삭제는 잔액이 0원일 때만 가능하며, 하위 내역까지 함께 지운다(개인정보 파기)
--  - 모든 접근은 매장 PIN을 검사하는 함수로만(schema.sql의 _pin_status 사용)

create table if not exists public.credit_accounts (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,          -- 숫자만
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_entries (
  id uuid primary key,                 -- 휴대폰에서 생성(다시 보내도 중복되지 않음)
  account_id uuid not null references public.credit_accounts(id) on delete cascade,
  kind text not null check (kind in ('issue', 'repay')),
  amount integer not null check (amount > 0),     -- 장부 금액(원): 외상액 또는 상환 차감액
  method text check (method in ('cash', 'card')), -- 상환 결제 형태
  paid_amount integer,                            -- 상환 때 실제 받은 금액(원)
  occurred_at timestamptz not null,
  business_date date,
  room_name text,
  entered_at timestamptz,                         -- 룸 입장 시각
  room_hours integer,
  service_hours integer,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists credit_entries_account_idx on public.credit_entries (account_id, occurred_at);

alter table public.credit_accounts enable row level security;
alter table public.credit_entries enable row level security;
revoke all on public.credit_accounts, public.credit_entries from anon, authenticated;

-- 명단 조회(잔액 포함). p_query: 이름 또는 전화번호 일부, 비우면 전체
create or replace function public.list_credit_accounts(p_pin text, p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
  v_q text := coalesce(trim(p_query), '');
  v_digits text := regexp_replace(coalesce(p_query, ''), '\D', '', 'g');
  v_rows jsonb;
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  select coalesce(jsonb_agg(t order by t.balance desc, t.updated_at desc), '[]'::jsonb) into v_rows
  from (
    select a.id, a.name, a.phone, a.updated_at,
      coalesce(sum(case when e.kind = 'issue' then e.amount else -e.amount end), 0)::integer as balance,
      max(e.occurred_at) as last_at
    from credit_accounts a
    left join credit_entries e on e.account_id = a.id
    where v_q = '' or a.name ilike '%' || v_q || '%' or (v_digits <> '' and a.phone like '%' || v_digits || '%')
    group by a.id
    limit 200
  ) t;
  return jsonb_build_object('ok', true, 'accounts', v_rows);
end;
$$;

-- 한 사람의 하위 내역과 잔액
create or replace function public.get_credit_account(p_pin text, p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
  v_account credit_accounts;
  v_entries jsonb;
  v_balance integer;
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  select * into v_account from credit_accounts where id = p_account_id;
  if v_account.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select coalesce(jsonb_agg(to_jsonb(e) - 'account_id' order by e.occurred_at desc), '[]'::jsonb),
         coalesce(sum(case when e.kind = 'issue' then e.amount else -e.amount end), 0)::integer
    into v_entries, v_balance
  from credit_entries e where e.account_id = p_account_id;
  return jsonb_build_object('ok', true, 'account', to_jsonb(v_account), 'balance', v_balance, 'entries', v_entries);
end;
$$;

-- 외상 발생 또는 상환 기록. 전화번호로 명단을 찾거나 만든다.
create or replace function public.add_credit_entry(p_pin text, p_entry jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
  v_kind text := p_entry->>'kind';
  v_phone text := regexp_replace(coalesce(p_entry->>'phone', ''), '\D', '', 'g');
  v_name text := nullif(trim(coalesce(p_entry->>'name', '')), '');
  v_amount integer := (p_entry->>'amount')::integer;
  v_account_id uuid;
  v_balance integer;
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  if v_kind not in ('issue', 'repay') or v_amount is null or v_amount <= 0 then
    return jsonb_build_object('ok', false, 'error', 'invalid_entry');
  end if;
  if length(v_phone) < 9 then
    return jsonb_build_object('ok', false, 'error', 'invalid_phone');
  end if;

  -- 이미 기록된 항목이면(재전송) 그대로 성공 처리
  if exists (select 1 from credit_entries where id = (p_entry->>'id')::uuid) then
    select account_id into v_account_id from credit_entries where id = (p_entry->>'id')::uuid;
  else
    if v_kind = 'issue' then
      if v_name is null then
        return jsonb_build_object('ok', false, 'error', 'invalid_name');
      end if;
      insert into credit_accounts (phone, name) values (v_phone, v_name)
      on conflict (phone) do update set name = excluded.name, updated_at = now()
      returning id into v_account_id;
    else
      select id into v_account_id from credit_accounts where phone = v_phone for update;
      if v_account_id is null then
        return jsonb_build_object('ok', false, 'error', 'not_found');
      end if;
      select coalesce(sum(case when kind = 'issue' then amount else -amount end), 0) into v_balance
        from credit_entries where account_id = v_account_id;
      if v_amount > v_balance then
        return jsonb_build_object('ok', false, 'error', 'over_balance');
      end if;
      update credit_accounts set updated_at = now() where id = v_account_id;
    end if;

    insert into credit_entries (
      id, account_id, kind, amount, method, paid_amount, occurred_at, business_date,
      room_name, entered_at, room_hours, service_hours, created_by
    ) values (
      (p_entry->>'id')::uuid, v_account_id, v_kind, v_amount, p_entry->>'method', (p_entry->>'paid_amount')::integer,
      (p_entry->>'occurred_at')::timestamptz, (p_entry->>'business_date')::date,
      p_entry->>'room_name', (p_entry->>'entered_at')::timestamptz,
      (p_entry->>'room_hours')::integer, (p_entry->>'service_hours')::integer, p_entry->>'created_by'
    );
  end if;

  select coalesce(sum(case when kind = 'issue' then amount else -amount end), 0) into v_balance
    from credit_entries where account_id = v_account_id;
  return jsonb_build_object('ok', true, 'account_id', v_account_id, 'balance', v_balance);
end;
$$;

-- 명단 삭제(전부 상환해 잔액 0원일 때만). 하위 내역도 함께 삭제된다.
create or replace function public.delete_credit_account(p_pin text, p_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
  v_balance integer;
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  perform 1 from credit_accounts where id = p_account_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select coalesce(sum(case when kind = 'issue' then amount else -amount end), 0) into v_balance
    from credit_entries where account_id = p_account_id;
  if v_balance <> 0 then
    return jsonb_build_object('ok', false, 'error', 'balance_remaining');
  end if;
  delete from credit_accounts where id = p_account_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.list_credit_accounts(text, text) from public;
revoke all on function public.get_credit_account(text, uuid) from public;
revoke all on function public.add_credit_entry(text, jsonb) from public;
revoke all on function public.delete_credit_account(text, uuid) from public;
grant execute on function public.list_credit_accounts(text, text) to anon, authenticated;
grant execute on function public.get_credit_account(text, uuid) to anon, authenticated;
grant execute on function public.add_credit_entry(text, jsonb) to anon, authenticated;
grant execute on function public.delete_credit_account(text, uuid) to anon, authenticated;
