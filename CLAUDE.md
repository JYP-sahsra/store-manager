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
- 방문 인원(`guests`): 대기 = 방문 − 서비스 건수(− `declined`, 현재 화면에서 입력하지 않아 항상 0). 현황 상태 `guestSummary` = none/waiting/partial/all. 금액과 무관한 운영 정보이며 일 마감 기록(서버)에는 들어가지 않는다.
- 룸 상태(`calc.roomStatus`, 룸 운영의 핵심은 시간제 서비스): 서비스 초과 'over'(추가 결제 필요, 결제를 마쳤어도) > 미결제 'due' > 종료 임박 'check'(확인 필요) > 주문 전 'fresh' > 대기 인원 'waiting' > 'normal'(정상 진행중). 타일에는 서비스 인원별 남은/초과 시간 칩을 둔다.
- 초과 자동 청구: 종료 시각을 넘긴 서비스는 `overtimeHours`(올림(초과 분/60), 최소 1)만큼 `unpaidLines`에 자동 포함(줄에 `overtimeHours` 표시). 저장된 `hours`는 그대로 두고, 결제 시 `markSessionPaid(session, now)`가 hours를 늘려 확정한다. 두 함수에 같은 `now`를 넘긴다. `overtimeCharge` = 미결제에 포함된 초과 금액(표시용).
- 룸 타일 식음료 표시: `drinkCounts` = 식음료 품목별 누적 수량(결제 여부 무관) + free(서비스 수량).
- 서비스(무료) 제공: 세션 `freeQuantities`(청구 안 함, `unpaidLines`에 들어가지 않음). 룸을 비울 때(`closeSession`: 종료·결제 후 종료·이용안함) `freeItems`를 `state.comps`에 기록하고, 일 마감 시 `buildCloseRecord({comps})`가 `by_item`에 kind 'comp'(sales 0, value = 정가 × 수량)로 넣는다. 금액 합계(net_total 등)는 변하지 않는다. 서버 스키마 변경 없음(by_item jsonb).
- 간이 계산기: `ui.calc`(화면 상태만, 저장·매출 기록 없음). 금액은 `calcPayment(판매액, 수단, 0)`, 더치페이는 `splitBill`(1인 100원 단위 올림, 차액 extra).
- 접기 영역 펼침 상태는 `ui.folds`(basic/rooms/items/calc)에 두고 toggle 이벤트(capture)로 갱신한다.
- 룸 이용안함: 기타 서비스가 하나라도 있으면 불가(버튼 숨김 + 동작에서도 차단). [이용안함 · 룸 비우기] 버튼으로 확인 후 세션을 비운다. 미결제 주문은 취소, 이미 받은 결제는 매출에 남는다. 이용안함 건수는 따로 기록하지 않는다.
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
- 영업일 서비스 제공 기록(`comps[]`): `id, roomId, roomName, sessionId, at, items[{itemId, name, qty, listPrice}]` — 마감 때 비운다.
- 세션(`sessions.roomN`): `id, startedAt, hours, quantities, paidHours, paidQuantities, freeQuantities, guests, declined, services[{id, itemId, startedAt, hours, paidHours}]` (`services`가 없던 예전 데이터는 빈 목록으로 정규화)
- 결제(`payments[]`): `id, roomId, roomName, sessionId, paidAt, method('cash'|'card'), lines[{kind('room'|'liquor'|'service'), itemId, name, unitPrice, qty, subtotal, serviceId?, startedAt?, overtimeHours?}], coveredBase, base, surcharge, discount, amount` (시간제 서비스 줄은 qty = 시간)
- 일 마감 기록: `buildCloseRecord()` 결과 = DB `day_closes` 컬럼(snake_case). 필드를 바꾸면 `schema.sql`의 `submit_day_close`도 같이 바꾼다.
- 백업 파일: `{ app: 'store-manager', exportedAt, state(PIN 제외), close }`

## 후속 작업

- 분할 결제(받을 금액 일부 입력, 잔액 이월) — `coveredBase`를 사용한다. 잔액 계산을 수량 기준에서 금액 기준으로 바꿔야 한다.
