# 로스트아크 숙제 체크리스트 서비스 설계

## 배경

이 프로젝트는 로스트아크의 일간, 주간, 격주간, 커스텀 초기화 숙제를 여러 캐릭터와 원정대 단위로 관리하는 공개 웹 서비스다.

런칭 직후 예상 사용량은 하루 활성 사용자 약 10명이다. 초기에는 무료 티어로 시작하되, 사용량이 늘어도 코드 구조를 크게 바꾸지 않고 월 $5 수준의 유료 플랜으로 올릴 수 있어야 한다.

## 제품 목표

- 스프레드시트와 비슷한 행렬형 체크리스트를 제공한다.
- 행은 숙제 항목, 열은 캐릭터로 구성한다.
- 캐릭터별 숙제와 원정대 단위 숙제를 모두 지원한다.
- 일간, 주간, 격주간, 커스텀 초기화 주기를 지원한다.
- 모든 초기화 계산은 `Asia/Seoul` 기준으로 처리한다.
- 일간 초기화는 매일 오전 6시 KST다.
- 주간 초기화는 매주 수요일 오전 6시 KST다.
- 수요일 오전 6시 KST에는 일간과 주간 숙제가 모두 초기화된다.
- 사용자가 행 높이, 열 너비, 화면 밀도 같은 행렬 간격을 조정할 수 있다.
- 로그인한 사용자의 체크 상태와 설정은 여러 기기에서 동기화된다.
- Discord 로그인과 Google 로그인을 지원한다.
- 로스트아크 Open API를 연결해 대표 캐릭터 검색으로 원정대 캐릭터를 불러오고, 사용자가 원하는 캐릭터만 선택해 등록할 수 있다.

## 호스팅 결정

주요 플랫폼은 Cloudflare로 한다.

- Cloudflare Pages: 정적 프론트엔드 호스팅.
- Cloudflare Workers: API 라우트, OAuth 콜백, 로스트아크 API 프록시, 캐싱, rate limit 처리.
- Cloudflare D1: 사용자, 캐릭터, 숙제 항목, 체크 상태, 사용자 설정 저장.
- Cloudflare KV 또는 Workers Cache: 로스트아크 API 응답과 낮은 위험도의 캐시 데이터 저장.
- Cloudflare Cron Triggers: 캐시 정리, 오래된 데이터 정리, 운영용 주기 작업.
- Cloudflare Turnstile: 로그인, 원정대 검색, 반복 API 호출 같은 남용 가능 경로 보호.

개발과 초기 공개 런칭은 Cloudflare Free로 시작한다. DAU가 100-300명 수준으로 꾸준히 증가하거나, 무료 한도의 약 50%에 가까워지면 Workers Paid 월 $5 전환을 검토한다.

## GitHub Pages 단독 사용이 어려운 이유

GitHub Pages는 정적 HTML, CSS, JavaScript 호스팅에는 적합하지만 이 서비스에는 서버 역할이 필요하다.

- 로스트아크 Open API JWT 보호.
- 사용자별 체크 상태 저장.
- Discord와 Google OAuth 처리.
- rate limit과 남용 방지.
- 로스트아크 API 응답 캐싱과 프록시.

로스트아크 API 키는 브라우저 JavaScript에 노출되면 안 된다. 따라서 백엔드 계층이 반드시 필요하다.

## 비용 모델

초기 예상 사용량은 약 10 DAU다. 이 규모에서는 체크 저장 batching과 API 캐싱을 처음부터 적용한다는 전제하에 Cloudflare Free로 충분히 시작할 수 있다.

예상 비용 경로:

- 개발 및 초기 런칭: 월 $0.
- 성장 단계: Workers Paid 월 $5.
- 커스텀 도메인: 별도 연 단위 도메인 비용.
- Workers, D1, KV, R2, Queues 포함량을 초과하거나 이메일, SMS, 유료 인증 SaaS를 붙이면 추가 비용이 발생할 수 있다.

500 DAU까지는 다음 조건을 지키면 Workers Paid 월 $5 안에 수용 가능하다고 본다.

- 대시보드 데이터는 한 번의 API로 묶어 가져온다.
- 체크 저장은 1-2초 debounce 또는 batch 저장으로 묶는다.
- 로스트아크 API 응답은 TTL 기반으로 캐싱한다.
- 사용자별 검색과 mutation 경로에 rate limit을 둔다.
- 정적 자산은 Worker를 거치지 않고 Pages에서 제공한다.

## 고려한 서비스

### 초기 포함

- Cloudflare Pages: 프론트엔드 배포.
- Cloudflare Workers: 백엔드 API.
- Cloudflare D1: 관계형 앱 데이터.
- Cloudflare KV 또는 Workers Cache: 로스트아크 API와 공개 데이터 캐시.
- Cloudflare Turnstile: 남용 방지.
- Cloudflare Cron Triggers: 주기 작업.
- D1 Time Travel: 실수로 데이터를 손상하거나 삭제했을 때 복구 가능성 확보.

### 이후 추가

- Cloudflare Queues: 캐릭터 일괄 등록, 로스트아크 API 재시도, 캐시 갱신 같은 비동기 작업.
- Cloudflare R2: 장기 백업 또는 운영 데이터 export 보관.
- Cloudflare Web Analytics: 개인정보 부담이 낮은 사용량 분석.
- 외부 uptime 및 에러 모니터링: 실제 사용자가 생긴 뒤 강화.

### 초기에는 제외

- AWS CloudFront: Cloudflare Pages가 이미 CDN 역할을 하며, 이 앱의 비용 압박은 정적 파일 전송보다 Workers/D1 동적 사용량에서 발생한다.
- Lightsail: 나중에는 가능하지만 첫 런칭에는 서버 운영, 배포, 패치, 백업 부담이 커진다.
- Odroid 홈 서버: 개인 실험에는 적합하지만 공개 서비스의 안정성, 보안, 네트워크 의존성 측면에서 초기 선택지로 두지 않는다.

## 인증

지원 로그인:

- Discord OAuth.
- Google OAuth.

초기 구현 방침:

- Cloudflare Workers와 D1에서 동작 가능한 인증 라이브러리를 우선 검토한다.
- 1순위 후보는 Auth.js다.
- Auth.js가 Worker 런타임이나 D1 세션 저장과 맞지 않으면 Better Auth 또는 작은 커스텀 OAuth 구현으로 전환한다.
- 사용자 ID와 provider 계정 연결 정보는 D1에 저장한다.
- 월 $0-$5 운영 목표를 유지하기 위해 Clerk, Kinde 같은 유료 인증 SaaS는 초기에는 사용하지 않는다.

## 로스트아크 API 연동

캐릭터 등록 흐름:

1. 사용자가 대표 캐릭터명을 입력한다.
2. Worker가 서버 측 API 키로 로스트아크 Open API를 호출한다.
3. Worker가 원정대/캐릭터 후보 목록을 프론트엔드에 반환한다.
4. 사용자가 등록할 캐릭터만 선택한다.
5. 선택한 캐릭터를 D1에 저장한다.

제약:

- 로스트아크 API 키는 Worker secrets에만 저장한다.
- 원정대와 캐릭터 조회 응답은 TTL 기반으로 캐싱한다.
- 원정대 검색은 사용자별, IP별 rate limit을 둔다.
- 외부 API 실패가 재시도 폭주로 이어지지 않도록 backoff와 실패 캐시를 둔다.

## 체크리스트 데이터 모델

핵심 개념:

- 사용자: OAuth 로그인을 통해 식별되는 서비스 사용자.
- 캐릭터: 사용자가 등록한 로스트아크 캐릭터.
- 숙제 항목: 일간, 주간, 격주간, 커스텀 초기화 규칙을 가진 체크리스트 행.
- 체크 상태: 특정 사용자, 숙제 항목, 캐릭터 또는 원정대 범위, 초기화 기간에 대한 완료 상태.

숙제 범위:

- 캐릭터 숙제: 캐릭터마다 별도로 체크한다.
- 원정대 숙제: 원정대 기준으로 한 번만 체크한다.

초기화 종류:

- 일간: 매일 오전 6시 KST.
- 주간: 매주 수요일 오전 6시 KST.
- 격주간: 설정된 기준 주차의 수요일 오전 6시 KST를 anchor로 하여 2주마다 초기화.
- 커스텀: interval, anchor time, timezone, optional weekday 조합으로 정의.

백엔드는 각 숙제 항목에 대해 KST 초기화 규칙을 적용해 안정적인 `period_key`를 계산한다. 체크 상태는 `period_key`에 묶어서 저장하므로 과거 기간 조회나 정리가 가능하다.

## 행렬 UI

기본 화면은 조밀한 체크리스트 행렬이다.

- 행은 숙제 항목이다.
- 열은 캐릭터다.
- 원정대 숙제는 MVP에서 별도의 `원정대` 열에 표시한다.
- 각 셀은 체크 또는 해제할 수 있다.
- 일간, 주간, 격주간, 커스텀 항목은 색상이나 작은 라벨로 구분한다.
- 사용자는 밀도 프리셋을 선택할 수 있다: `편안하게`, `기본`, `조밀하게`.
- 고급 설정으로 행 높이와 열 너비를 직접 조정할 수 있다.
- 데스크톱 화면을 우선 설계하고, 모바일은 가로 스크롤과 압축 뷰로 대응한다.

로그인 후 첫 화면은 마케팅 페이지가 아니라 실제 체크리스트 도구여야 한다.

## 데이터 흐름

대시보드 로드:

1. 프론트엔드가 단일 dashboard API를 요청한다.
2. Worker가 사용자를 인증한다.
3. Worker가 D1에서 캐릭터, 숙제 항목, 설정, 현재 기간 체크 상태를 읽는다.
4. Worker가 행렬 렌더링에 필요한 정규화된 payload를 반환한다.

체크 상태 업데이트:

1. 사용자가 하나 이상의 셀을 체크하거나 해제한다.
2. 프론트엔드가 optimistic update를 적용한다.
3. 프론트엔드가 짧은 debounce로 변경 사항을 묶는다.
4. Worker가 소유권, 숙제 범위, 기간 키를 검증한다.
5. Worker가 실제로 바뀐 체크 상태만 D1에 저장한다.
6. 프론트엔드가 저장 결과와 화면 상태를 reconcile한다.

## 비용 및 안정성 방어 장치

- 체크 저장은 batch/debounce한다.
- 대시보드는 작은 API 여러 개보다 큰 payload 하나를 우선한다.
- D1에는 사용자, 숙제, 캐릭터, 기간 조회에 필요한 인덱스를 둔다.
- 로스트아크 API 응답을 캐싱한다.
- 원정대 검색, 캐릭터 import, 반복 mutation 경로에 rate limit을 둔다.
- 남용 가능 경로에 Turnstile을 붙인다.
- Workers와 D1 사용량을 초반부터 모니터링한다.
- Free에서 Workers Paid로 올릴 때 앱 코드 변경이 필요 없도록 구성한다.

## 초기 MVP 범위

포함:

- Cloudflare Pages 프론트엔드.
- Cloudflare Worker API.
- D1 스키마와 migration.
- Discord 및 Google 로그인.
- 수동 숙제 생성/수정.
- 로스트아크 Open API 기반 캐릭터 import.
- import 시 등록할 캐릭터 선택.
- 행렬형 체크리스트 화면.
- 일간, 주간, 격주간, 커스텀 초기화 규칙.
- 캐릭터 단위와 원정대 단위 숙제.
- 사용자별 밀도/간격 설정.

초기 기본 숙제 템플릿:

- 쿠르잔 전선: 일간, 캐릭터 단위.
- 가디언 토벌: 일간, 캐릭터 단위.
- 4막: 아르모체: 주간, 캐릭터 단위.
- 종막: 카제로스: 주간, 캐릭터 단위.
- 세르카: 초기에는 사용자가 직접 범위와 주기를 지정할 수 있는 예시 항목으로 둔다.

제외:

- 모바일 우선 재설계.
- push 알림.
- 이메일 또는 SMS 리마인더.
- 길드/파티 공유.
- 공개 숙제 템플릿 마켓플레이스.
- 유료 구독.
- 고급 분석 기능.

## 데이터 보관

- 기본 체크 상태는 최근 180일을 보관한다.
- 180일이 지난 체크 상태는 Cron 작업으로 삭제할 수 있다.
- 사용자가 직접 삭제한 캐릭터의 체크 이력은 즉시 삭제하지 않고 30일 soft delete 기간을 둔다.
- 장기 백업이 필요해지면 R2 export를 추가한다.

## 구현 전 확인할 사항

- Auth.js가 현재 Cloudflare Workers와 D1 조합에서 필요한 OAuth/session 요구사항을 만족하는지 확인한다.
- 로스트아크 Open API에서 원정대 캐릭터 일괄 조회에 사용할 정확한 endpoint와 응답 제한을 확인한다.
- 기본 숙제 템플릿의 이름, 주기, 캐릭터/원정대 범위를 실제 게임 용어 기준으로 확정한다.
- 원정대 숙제를 `원정대` 열로 표현하는 UI가 첨부 이미지의 기대와 맞는지 확인한다.

## 참고 링크

- GitHub Pages: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- Lost Ark Open API: https://api-lostark.game.onstove.com/getting-started
- Cloudflare Workers Pricing: https://developers.cloudflare.com/workers/platform/pricing/
- Cloudflare D1 Pricing: https://developers.cloudflare.com/d1/platform/pricing/
- Cloudflare D1 Time Travel: https://developers.cloudflare.com/d1/reference/time-travel/
- Cloudflare Turnstile Plans: https://developers.cloudflare.com/turnstile/plans/
