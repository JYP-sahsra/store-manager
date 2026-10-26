# store-manager 프로젝트 규칙

3개 룸 매장의 판매 카운트·결제·일 마감 모바일 웹앱(PWA). 사용 방법과 배포는 README.md.

## 구조

- 빌드·npm 의존성 없음. 브라우저 ES modules를 그대로 배포(GitHub Pages, main 브랜치 root).
- `js/calc.js` — 금액 계산 순수 함수(화면·저장 코드 금지). 계산 규칙을 바꾸면 `tests/calc.test.js`도 함께 바꾼다.
- `js/storage.js` — localStorage 저장, 기본값, 데이터 정규화·검증, 백업 파일.
- `js/api.js` — Supabase RPC 호출(fetch). 테이블 직접 접근 금지, `supabase/schema.sql`의 함수만 사용.
- `js/app.js` — 화면 렌더링(문자열 템플릿 + 이벤트 위임). 사용자 입력 문자열은 `esc()`로 출력한다.
- `js/config.js` — Supabase URL과 publishable(anon) key만. service_role key 금지.
- `sw.js` — network-first 캐시. 앱 파일을 추가하거나 이름을 바꾸면 `SHELL` 목록과 `CACHE` 버전을 갱신한다.

## 명령

- `npm test` — node 내장 테스트 러너
- `npm run dev` — 개발 서버 http://localhost:5180 (브라우저 미리보기: `.claude/launch.json`의 `store-manager`)
- `npm run icons` — 아이콘 PNG 재생성

## 확정된 업무 규칙

- 금액은 원(KRW) 정수. 현금 = 판매액 − 할인. 카드 = 판매액 + round(판매액 × 10%) − 할인. 할인은 할인 전 금액을 넘을 수 없다.
- 결제는 룸 시작·종료와 따로 한다. 결제 1건 = 직전 결제 이후 미결제 수량 전체. 결제한 수량 아래로는 줄일 수 없다.
- 미결제 잔액이 있으면 룸을 종료할 수 없다(결제 후 종료).
- 이용 중인 룸이 있으면 일 마감을 할 수 없다.
- 영업일 = 영업 시작부터 [일 마감]까지. 날짜는 첫 룸 시작 시각 기준이며, `dayCutoffHour`(기본 0) 이전이면 전날로 친다.
- 가격은 관리자가 폰에서 바로 바꾸고 서버에 저장한다(승인 절차 없음). `updatedAt`/`updatedBy`를 기록한다.
- 결제 기록에는 품목 이름·단가를 복사해 둔다. 이후 가격이 바뀌어도 과거 기록은 바뀌지 않는다.

## 데이터 계약

- localStorage 키 `storeManager.v1`, `version: 1`. 구조를 바꾸면 version을 올리고 `normalizeState`에 변환 코드를 추가한다.
- 결제(`payments[]`): `id, roomId, roomName, sessionId, paidAt, method('cash'|'card'), lines[{kind('room'|'liquor'|'service'), itemId, name, unitPrice, qty, subtotal}], coveredBase, base, surcharge, discount, amount`
- 일 마감 기록: `buildCloseRecord()` 결과 = DB `day_closes` 컬럼(snake_case). 필드를 바꾸면 `schema.sql`의 `submit_day_close`도 같이 바꾼다.
- 백업 파일: `{ app: 'store-manager', exportedAt, state(PIN 제외), close }`

## 후속 작업

- 분할 결제(받을 금액 일부 입력, 잔액 이월) — `coveredBase`를 사용한다. 잔액 계산을 수량 기준에서 금액 기준으로 바꿔야 한다.
