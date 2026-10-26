# store-manager 프로젝트 규칙

3개 룸 매장의 판매 카운트·결제·일 마감 모바일 웹앱(PWA). 사용 방법과 배포는 README.md.

## 구조

- 빌드·npm 의존성 없음. 브라우저 ES modules를 그대로 배포(GitHub Pages, main 브랜치 root).
- `js/calc.js` — 금액 계산 순수 함수(화면·저장 코드 금지). 계산 규칙을 바꾸면 `tests/calc.test.js`도 함께 바꾼다.
- `js/storage.js` — localStorage 저장, 기본값, 데이터 정규화·검증, 백업 파일.
- `js/calendar.js` — 매출 월 캘린더 계산 순수 함수(월 범위, 달력 칸, 날짜별 합계, 만원 표기). `tests/calendar.test.js`.
- `js/api.js` — Supabase RPC 호출(fetch). 테이블 직접 접근 금지, `supabase/schema.sql`의 함수만 사용.
- `js/app.js` — 화면 렌더링(문자열 템플릿 + 이벤트 위임). 사용자 입력 문자열은 `esc()`로 출력한다.
- `js/config.js` — Supabase URL과 publishable(anon) key만. service_role key 금지.
- `sw.js` — network-first 캐시(`fetch(req, { cache: 'no-cache' })`로 Pages의 max-age=600을 건너뛴다). **배포마다 `CACHE` 버전을 올린다** — 관리 탭의 앱 버전 표시와 새 버전 감지에 쓰인다. 앱 파일을 추가하거나 이름을 바꾸면 `SHELL` 목록도 갱신한다.
- 앱 업데이트: `app.js`의 `watchForUpdates`가 기존 버전이 있을 때 새 SW 활성화를 감지해 다시 연다(결제·입력 중이면 미룸). 화면 복귀(visibilitychange)와 [동기화] 버튼이 `registration.update()`를 호출한다.

## 명령

- `npm test` — node 내장 테스트 러너
- `npm run dev` — 개발 서버 http://localhost:5180 (브라우저 미리보기: `.claude/launch.json`의 `store-manager`)
- `npm run icons` — 아이콘 PNG 재생성

## 확정된 업무 규칙

- 금액은 원(KRW) 정수. 현금 = 판매액 − 할인. 카드 = 판매액 + round(판매액 × 10%) − 할인. 할인은 할인 전 금액을 넘을 수 없다.
- 결제는 룸 시작·종료와 따로 한다. 결제 1건 = 직전 결제 이후 미결제 수량 전체. 결제한 수량 아래로는 줄일 수 없다.
- 분류: `liquor`(화면 이름 "식음료", 수량제) / `service`(화면 이름 "기타 서비스", **1인 1건 시간제**). 키는 데이터 호환을 위해 바꾸지 않는다.
- 시간제 서비스: 금액 = 1명·1시간 가격 × 시간. 추가 시각이 시작 시각(수정 가능, 자정 보정 `withTimeOfDay`), 종료 예정 = 시작 + 시간. 종료 `ENDING_SOON_MINUTES`(10분) 전 'ending', 지나면 'over'로 강조. 결제한 시간 아래로 못 줄이고, 결제 기록이 없을 때만 삭제(시간이 남아 있어도 가능, 카드의 [삭제] + 확인 창).
- 룸 이용 시간은 입장~종료 전체 총시간이며 서비스 시간과 별개다. 룸 타일에는 룸 경과 시간 대신 입장 시각과 서비스 인원별 경과 시간을 보여 준다.
- 방문 인원(`guests`)·이용안함(`declined`): 대기 = 방문 − 서비스 건수 − 이용안함. 현황 상태 `guestSummary` = none/waiting/partial/all/declined. 금액과 무관한 운영 정보이며 현재 일 마감 기록(서버)에는 들어가지 않는다.
- 미결제 잔액이 있으면 룸을 종료할 수 없다(결제 후 종료).
- 이용 중인 룸이 있으면 일 마감을 할 수 없다.
- 일 마감은 서버에만 저장한다(파일 다운로드 없음). 업로드 전 `pendingUploads`에 먼저 보관해 실패 시 재시도한다. 매출은 매출 탭의 월 캘린더(`list_day_closes`, 서버 미연결 시 `closeHistory`)로 본다.
- 영업일 = 20시 ~ 다음날 12시(정오) 전, 시작한 날 매출로 기록한다. 영업일은 영업 시작부터 [일 마감]까지이며, 날짜는 첫 룸 시작 시각 기준으로 `dayCutoffHour`(기본 12) 이전이면 전날로 친다.
- 마감을 빠뜨린 지난 영업일(`isStaleBusinessDay`)이면 경고하고, 룸 시작 시 확인을 받는다.
- 가격은 관리자가 폰에서 바로 바꾸고 서버에 저장한다(승인 절차 없음). `updatedAt`/`updatedBy`를 기록한다.
- 결제 기록에는 품목 이름·단가를 복사해 둔다. 이후 가격이 바뀌어도 과거 기록은 바뀌지 않는다.

## 데이터 계약

- localStorage 키 `storeManager.v1`, `version: 1`. 구조를 바꾸면 version을 올리고 `normalizeState`에 변환 코드를 추가한다.
- 설정(`settings`)은 `settingsVersion`(현재 2)을 가진다. v1(필드 없음)의 `dayCutoffHour: 0`은 12로 옮긴다(`normalizeSettings`). 서버 `store_settings.data`도 같은 형식.
- 세션(`sessions.roomN`): `id, startedAt, hours, quantities, paidHours, paidQuantities, guests, declined, services[{id, itemId, startedAt, hours, paidHours}]` (`services`가 없던 예전 데이터는 빈 목록으로 정규화)
- 결제(`payments[]`): `id, roomId, roomName, sessionId, paidAt, method('cash'|'card'), lines[{kind('room'|'liquor'|'service'), itemId, name, unitPrice, qty, subtotal, serviceId?, startedAt?}], coveredBase, base, surcharge, discount, amount` (시간제 서비스 줄은 qty = 시간)
- 일 마감 기록: `buildCloseRecord()` 결과 = DB `day_closes` 컬럼(snake_case). 필드를 바꾸면 `schema.sql`의 `submit_day_close`도 같이 바꾼다.
- 백업 파일: `{ app: 'store-manager', exportedAt, state(PIN 제외), close }`

## 후속 작업

- 분할 결제(받을 금액 일부 입력, 잔액 이월) — `coveredBase`를 사용한다. 잔액 계산을 수량 기준에서 금액 기준으로 바꿔야 한다.
