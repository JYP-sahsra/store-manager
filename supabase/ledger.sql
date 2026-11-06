-- 장부(현금출납) (schema.sql을 먼저 실행한 뒤, Supabase SQL Editor에서 이 파일 전체를 실행)
-- 다시 실행해도 안전하다(if not exists / create or replace).
--
-- 항목(kind): expense(지출, method = cash/card/transfer) / cash_out(시재 회수) / cash_in(시재 보충) / set(시재 맞춤)
-- 수입은 일 마감 기록(day_closes)에서 가져오므로 여기에 저장하지 않는다.
-- 모든 접근은 매장 PIN을 검사하는 함수로만(schema.sql의 _pin_status 사용). 금액은 원 단위 정수.

create table if not exists public.ledger_entries (
  id uuid primary key,                 -- 휴대폰에서 생성(같은 id로 다시 저장하면 수정)
  business_date date not null,         -- 영업일
  kind text not null check (kind in ('expense', 'cash_out', 'cash_in', 'set')),
  description text,
  amount integer not null check (amount >= 0),
  method text check (method in ('cash', 'card', 'transfer')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now()
);
create index if not exists ledger_entries_date_idx on public.ledger_entries (business_date);

alter table public.ledger_entries enable row level security;
revoke all on public.ledger_entries from anon, authenticated;

-- 기간 조회 + 기간 끝 이전의 가장 최근 시재 맞춤 날짜(시재 계산 시작점)
create or replace function public.list_ledger(p_pin text, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
  v_rows jsonb;
  v_last_set date;
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.business_date, e.created_at), '[]'::jsonb) into v_rows
    from ledger_entries e where e.business_date between p_from and p_to;
  select max(business_date) into v_last_set from ledger_entries where kind = 'set' and business_date <= p_to;
  return jsonb_build_object('ok', true, 'entries', v_rows, 'last_set_date', v_last_set);
end;
$$;

-- 추가 또는 수정(같은 id면 수정)
create or replace function public.save_ledger_entry(p_pin text, p_entry jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
  v_kind text := p_entry->>'kind';
  v_amount integer := (p_entry->>'amount')::integer;
  v_method text := nullif(p_entry->>'method', '');
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  if v_kind not in ('expense', 'cash_out', 'cash_in', 'set') or v_amount is null or v_amount < 0
     or (v_kind = 'expense' and (v_method is null or v_method not in ('cash', 'card', 'transfer'))) then
    return jsonb_build_object('ok', false, 'error', 'invalid_ledger');
  end if;
  insert into ledger_entries (id, business_date, kind, description, amount, method, created_by, updated_by)
  values (
    (p_entry->>'id')::uuid, (p_entry->>'business_date')::date, v_kind, p_entry->>'description', v_amount,
    case when v_kind = 'expense' then v_method end, p_entry->>'by', p_entry->>'by'
  )
  on conflict (id) do update set
    business_date = excluded.business_date, kind = excluded.kind, description = excluded.description,
    amount = excluded.amount, method = excluded.method, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.delete_ledger_entry(p_pin text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := _pin_status(p_pin);
begin
  if v_status <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_status);
  end if;
  delete from ledger_entries where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.list_ledger(text, date, date) from public;
revoke all on function public.save_ledger_entry(text, jsonb) from public;
revoke all on function public.delete_ledger_entry(text, uuid) from public;
grant execute on function public.list_ledger(text, date, date) to anon, authenticated;
grant execute on function public.save_ledger_entry(text, jsonb) to anon, authenticated;
grant execute on function public.delete_ledger_entry(text, uuid) to anon, authenticated;
