# 벨가 숙제 프리셋 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 숙제 추가 화면에 `벨가` 주간 프리셋을 추가하고 검증된 `main`을 운영에 배포한다.

**Architecture:** 기존 `TaskForm`의 정적 `LOST_ARK_TASK_PRESETS` 배열에 항목 하나를 추가한다. 기존 프리셋 선택 흐름을 그대로 사용하므로 API와 데이터베이스는 변경하지 않으며, 데이터·표시·접근성 이름을 기존 단위 테스트로 고정한다.

**Tech Stack:** React 19, TypeScript, Vitest, Vite, Cloudflare Pages

## Global Constraints

- ID는 `velgardin`이다.
- 표시명은 `벨가`, 상세명은 `죽음의 계율자, 벨가르딘`이다.
- 초기화 주기는 `weekly`, 색상은 `#1d4ed8`이다.
- `세르카` 다음, `성당` 이전에 표시한다.
- 서버 API와 데이터베이스 형식은 변경하지 않는다.
- 기존의 관련 없는 `image/`, `outputs/` 파일은 수정하거나 커밋하지 않는다.

---

### Task 1: 벨가 프리셋과 회귀 테스트

**Files:**
- Modify: `apps/web/src/features/tasks/TaskForm.test.ts`
- Modify: `apps/web/src/features/tasks/TaskForm.tsx`

**Interfaces:**
- Consumes: `LOST_ARK_TASK_PRESETS: LostArkTaskPreset[]`, 기존 `applyPreset` 동작
- Produces: `id: "velgardin"`인 주간 프리셋과 `벨가 숙제 프리셋 적용` 버튼

- [ ] **Step 1: 실패하는 프리셋 테스트 작성**

`TaskForm.test.ts`의 전체 프리셋 기대 배열에서 `serka`와 `cathedral` 사이에 다음 객체를 추가한다.

```ts
{ id: "velgardin", title: "죽음의 계율자, 벨가르딘", label: "벨가", resetType: "weekly", color: "#1d4ed8" },
```

같은 테스트의 화면 검증에 다음 기대값을 추가한다.

```ts
expect(html).toContain("죽음의 계율자, 벨가르딘");
```

프리셋 버튼 연결 테스트에 다음 기대값을 추가한다.

```ts
expect(source).toContain('aria-label="벨가 숙제 프리셋 적용"');
```

- [ ] **Step 2: 테스트가 올바른 이유로 실패하는지 확인**

Run: `pnpm vitest run apps/web/src/features/tasks/TaskForm.test.ts`

Expected: 기존 프리셋 배열에 `velgardin`이 없고 렌더링 결과에 벨가 문구가 없어 FAIL한다.

- [ ] **Step 3: 최소 구현 추가**

`TaskForm.tsx`의 `LOST_ARK_TASK_PRESETS`에서 `serka` 다음에 아래 객체를 추가한다.

```ts
{ id: "velgardin", title: "죽음의 계율자, 벨가르딘", label: "벨가", resetType: "weekly", color: "#1d4ed8" },
```

- [ ] **Step 4: 집중 테스트와 웹 타입 검사 실행**

Run: `pnpm vitest run apps/web/src/features/tasks/TaskForm.test.ts`

Expected: `TaskForm` 테스트 전체 PASS.

Run: `pnpm --filter @riceark/web check`

Expected: TypeScript 오류 없이 PASS.

- [ ] **Step 5: 구현 커밋**

```bash
git add apps/web/src/features/tasks/TaskForm.tsx apps/web/src/features/tasks/TaskForm.test.ts
git commit -m "Add Velgardin task preset"
```

### Task 2: 전체 검증, 푸시, 운영 배포

**Files:**
- Verify only: repository workspace

**Interfaces:**
- Consumes: Task 1의 `main` 커밋
- Produces: 원격 `main`과 일치하는 Cloudflare Pages 운영 배포

- [ ] **Step 1: 전체 검증 실행**

Run: `pnpm check`

Expected: 모든 워크스페이스 타입 검사 PASS.

Run: `pnpm test`

Expected: 전체 Vitest 테스트 PASS.

Run: `pnpm --filter @riceark/web build`

Expected: Vite 프로덕션 빌드 PASS.

Run: `git diff --check HEAD~1..HEAD`

Expected: 출력 없이 종료 코드 0.

- [ ] **Step 2: 원격 main 푸시**

Run: `git push origin main`

Expected: `origin/main`이 로컬 `main` 구현 커밋을 가리킨다.

- [ ] **Step 3: Cloudflare Pages 배포**

Run: `pnpm --filter @riceark/web run deploy`

Expected: Wrangler가 `riceark` Production 배포 URL과 성공 상태를 출력한다. 별도 API Worker는 배포하지 않는다.

- [ ] **Step 4: 운영 스모크 검증**

Run: `curl -sS -i https://riceark.pages.dev/api/health`

Expected: HTTP 200과 `{"ok":true,"service":"riceark-api"}`.

Run: `pnpm --filter @riceark/web exec wrangler pages deployment list --project-name riceark`

Expected: 최신 Production 배포의 Branch가 `main`, Source가 푸시한 구현 커밋이다.

Run: `curl -sS https://riceark.pages.dev/`

Expected: 새 Vite 빌드의 JS/CSS 자산 이름을 참조하는 HTML이 반환된다.
