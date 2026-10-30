-- 정식 운영 전환: 시범 운영 기간(영업일 2026-10-31까지)의 서버 매출 데이터 정리
-- 지우는 것: 마감 기록(day_closes), 외상 장부 내역(credit_entries)과 내역이 없어진 외상 명단(credit_accounts)
-- 남기는 것: 가격 설정(store_settings), 매장 PIN(store_secret), 테이블·함수 구조
--
-- 실행 시점: 10/31 시범 영업까지 마감한 뒤, 11/1 영업(20시) 시작 전
-- 실행 방법: Supabase SQL Editor에서 ① 확인 → ② 삭제 순서로 각각 실행한다.

-- ① 확인: 지워질 건수를 먼저 본다(아무것도 지우지 않음)
select 'day_closes(마감 기록)' as 대상, count(*) as 지울_건수
  from public.day_closes where business_date < date '2026-11-01'
union all
select 'credit_entries(외상·상환 내역)', count(*)
  from public.credit_entries
  where coalesce(business_date, (occurred_at at time zone 'Asia/Seoul')::date) < date '2026-11-01'
union all
select 'credit_accounts(외상 명단, 내역이 모두 시범 기간인 경우)', count(*)
  from public.credit_accounts a
  where not exists (
    select 1 from public.credit_entries e
    where e.account_id = a.id
      and coalesce(e.business_date, (e.occurred_at at time zone 'Asia/Seoul')::date) >= date '2026-11-01'
  );

-- ② 삭제: 위 건수가 맞으면 아래 begin ~ commit 블록 전체를 선택해 실행한다.
begin;

delete from public.day_closes
  where business_date < date '2026-11-01';

delete from public.credit_entries
  where coalesce(business_date, (occurred_at at time zone 'Asia/Seoul')::date) < date '2026-11-01';

-- 내역이 하나도 남지 않은 외상 명단(이름·전화번호)도 지운다.
delete from public.credit_accounts a
  where not exists (select 1 from public.credit_entries e where e.account_id = a.id);

delete from public.pin_failures;

commit;
