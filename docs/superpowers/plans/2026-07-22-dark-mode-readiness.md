# Dark Mode Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 검수에서 확인된 RiceArk 다크모드 가독성과 테마 범위 문제를 수정한다.

**Architecture:** 루트에 의미 색상 토큰을 정의하고 공통 UI 표면은 토큰 기반 다크 규칙으로 통합한다. 앱 셸 밖 포털은 `:root[data-theme="dark"]` 선택자로 처리하고, 저장 테마는 앱 부팅 전에 적용한다.

**Tech Stack:** React, TypeScript, CSS, Vitest, Vite

---

### Task 1: Dark theme contract tests

**Files:**
- Modify: `apps/web/src/styles.test.ts`
- Modify: `apps/web/src/App.test.ts`

- [x] 루트 테마 토큰과 초기 테마 부트스트랩 테스트를 추가한다.
- [x] 공통 모달·폼·설정 표면의 다크 규칙 테스트를 추가한다.
- [x] 보드 정보와 포털 요소의 다크 규칙 테스트를 추가한다.
- [x] 관련 테스트를 실행해 의도한 이유로 실패하는지 확인한다.

### Task 2: Root theme foundation

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/index.html`

- [x] `:root`와 `:root[data-theme="dark"]`에 의미 색상 토큰을 정의한다.
- [x] `html`, `body`, 앱 셸의 배경과 색상을 토큰에 연결한다.
- [x] 저장된 테마를 앱 스크립트 전에 적용한다.
- [x] 저장소 예외 처리와 브라우저 테마 색상 동기화를 추가한다.
- [x] 관련 테스트를 실행해 통과하는지 확인한다.

### Task 3: Shared surfaces and board content

**Files:**
- Modify: `apps/web/src/styles.css`

- [x] 공통 모달, 폼, 탭 설정, 도구 패널과 검색 결과에 다크 규칙을 추가한다.
- [x] 저장 및 삭제 버튼의 의미 색상이 공통 다크 버튼 규칙에 덮이지 않게 한다.
- [x] 캐릭터 메타데이터와 일정 정보에 다크 규칙을 추가한다.
- [x] 포털 툴팁·드래그 오버레이와 비활성 체크칸에 루트 기반 다크 규칙을 추가한다.
- [x] 관련 테스트를 실행해 통과하는지 확인한다.

### Task 4: Full verification

**Files:**
- Test: `apps/web/src/styles.test.ts`
- Test: `apps/web/src/App.test.ts`

- [x] `pnpm check`와 `pnpm test`를 실행한다.
- [x] 데스크톱 및 모바일 화면을 시각 검수한다.
- [x] 콘솔 오류, 가로 넘침, 주요 텍스트 대비를 확인한다.
