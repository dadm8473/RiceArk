# Batch Character Refresh Failure Details Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 표의 캐릭터 정보 일괄 업데이트가 일부 실패했을 때 실패한 캐릭터 이름과 한국어 사유를 추가 서버 요청 없이 표시한다.

**Architecture:** 기존 배치 API 응답의 비성공 항목을 `TableCharacterRefreshFailure`로 변환하고, 현재 표의 축 항목으로 만든 ID-이름 맵과 결합한다. `TableCharacterRefreshSummary`가 상세 배열을 모달에 전달하며, 모달은 기존 요약 아래에 최대 높이가 제한된 실패 목록을 렌더링한다. API와 데이터베이스는 변경하지 않는다.

**Tech Stack:** React 19, TypeScript 5.9, Vitest 3, CSS, pnpm

## Global Constraints

- 기존 `/api/characters/refresh-batch` 응답만 사용하며 추가 API 요청을 만들지 않는다.
- 성공한 캐릭터 적용, 최대 40명 제한, 요청 자체 실패 동작을 유지한다.
- 내부 실패 코드는 사용자에게 노출하지 않는다.
- 별도의 항목별 재시도 기능을 추가하지 않는다.
- 실패 목록은 모바일과 데스크톱에서 겹치지 않고 긴 목록만 내부 스크롤한다.

---

### Task 1: Preserve And Describe Batch Failures

**Files:**
- Modify: `apps/web/src/features/board/BoardOverview.tsx:190-405`
- Test: `apps/web/src/features/board/BoardOverview.test.ts:940-1135`

**Interfaces:**
- Consumes: `BoardCharacterRefreshBatchItem`, `BoardAxisItem[]`, requested `characterIds: string[]`
- Produces: `TableCharacterRefreshFailure`, `getBoardCharacterRefreshFailureReason(result)`, `getBoardCharacterNamesById(tableId, axisItems)`, and `TableCharacterRefreshSummary.failures`

- [ ] **Step 1: Write the failing mixed-result detail test**

Extend the mixed-status test so the request helper must preserve status details:

```ts
await expect(
  refreshBoardTableCharactersRequest(
    results.map((result) => result.id),
    applyLocal,
    vi.fn(async () => ({ results, versions: { sheets: [] } }))
  )
).resolves.toEqual({
  failedCount: 5,
  refreshedCount: 1,
  totalCount: 6,
  failures: [
    { id: "manual", reason: "수동 캐릭터는 자동 갱신할 수 없습니다." },
    { id: "missing", reason: "저장된 캐릭터를 찾을 수 없습니다." },
    { id: "unavailable", reason: "로스트아크에서 캐릭터 정보를 찾지 못했습니다." },
    { id: "rate", reason: "17초 뒤 다시 시도해주세요." },
    { id: "failed", reason: "일시적인 API 오류입니다." }
  ]
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test apps/web/src/features/board/BoardOverview.test.ts -t "derives refreshed and failed counts"
```

Expected: FAIL because the summary has no `failures` property.

- [ ] **Step 3: Add the failure model and status mapper**

Add:

```ts
export interface TableCharacterRefreshFailure {
  id: string;
  name?: string | undefined;
  reason: string;
}

export function getBoardCharacterRefreshFailureReason(
  result: Exclude<BoardCharacterRefreshBatchItem, BoardCharacterRefreshUpdatedResult>
): string {
  switch (result.status) {
    case "rate_limited":
      return `${result.retryAfterSeconds}초 뒤 다시 시도해주세요.`;
    case "not_available":
      return "로스트아크에서 캐릭터 정보를 찾지 못했습니다.";
    case "not_found":
      return "저장된 캐릭터를 찾을 수 없습니다.";
    case "manual":
      return "수동 캐릭터는 자동 갱신할 수 없습니다.";
    case "failed":
      return "일시적인 API 오류입니다.";
  }
}
```

Add `failures: TableCharacterRefreshFailure[]` to every summary result and map every non-updated response in response order.

- [ ] **Step 4: Add the table-scoped character name mapper test**

Add a test that passes duplicate references and verifies one stable name per ID:

```ts
expect(getBoardCharacterNamesById("table-1", axisItems)).toEqual(new Map([
  ["character-1", "냠냠수빈"],
  ["character-2", "펄쩍수빈"]
]));
```

- [ ] **Step 5: Implement the name mapper and enrich the summary in the table owner**

Implement:

```ts
export function getBoardCharacterNamesById(
  tableId: string,
  axisItems: BoardAxisItem[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const item of axisItems) {
    if (item.table_id !== tableId || !item.character_id || names.has(item.character_id)) continue;
    names.set(item.character_id, getBoardCharacterName(item));
  }
  return names;
}
```

In `handleRefreshTableCharacters`, enrich each failure with `name: names.get(failure.id) ?? failure.id` before returning it to the modal.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
pnpm test apps/web/src/features/board/BoardOverview.test.ts -t "refresh|failed|character name"
```

Expected: all selected tests PASS.

- [ ] **Step 7: Commit the data-flow change**

```bash
git add apps/web/src/features/board/BoardOverview.tsx apps/web/src/features/board/BoardOverview.test.ts
git commit -m "Show batch character refresh failures"
```

---

### Task 2: Render The Failure List

**Files:**
- Modify: `apps/web/src/features/board/BoardOverview.tsx:3230-3320`
- Modify: `apps/web/src/styles.css:3210-3260`
- Test: `apps/web/src/features/board/BoardOverview.test.ts:860-930,1080-1145`

**Interfaces:**
- Consumes: `TableCharacterRefreshSummary.failures`
- Produces: `.board-character-refresh-failures` list with one row per failure

- [ ] **Step 1: Write the failing modal rendering test**

Render `BoardTableToolModal` with a summary containing two failures and assert:

```ts
expect(html).toContain("2명 업데이트, 2명 실패했습니다.");
expect(html).toContain('class="board-character-refresh-failures"');
expect(html).toContain("냠수나이스1");
expect(html).toContain("17초 뒤 다시 시도해주세요.");
expect(html).toContain("펄쩍수빈");
expect(html).toContain("일시적인 API 오류입니다.");
```

- [ ] **Step 2: Run the modal test and verify RED**

Run:

```bash
pnpm test apps/web/src/features/board/BoardOverview.test.ts -t "renders batch refresh failure details"
```

Expected: FAIL because the list is not rendered.

- [ ] **Step 3: Store failures and render semantic list markup**

Add `refreshFailures` state, clear it before each request, set it from the result, and render:

```tsx
{refreshFailures.length > 0 ? (
  <ul className="board-character-refresh-failures" aria-label="업데이트 실패 캐릭터">
    {refreshFailures.map((failure) => (
      <li key={failure.id}>
        <strong>{failure.name ?? failure.id}</strong>
        <span>{failure.reason}</span>
      </li>
    ))}
  </ul>
) : null}
```

Clear the list for total success, validation errors, and thrown request failures so stale results never remain.

- [ ] **Step 4: Add compact responsive styles**

Add styles with these constraints:

```css
.board-character-refresh-failures {
  grid-column: 1 / -1;
  max-height: 156px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.board-character-refresh-failures li {
  display: grid;
  grid-template-columns: minmax(88px, auto) minmax(0, 1fr);
  gap: 8px;
  padding: 5px 0;
}
```

At the existing mobile breakpoint, use one column so long names and reasons wrap without horizontal overflow.

- [ ] **Step 5: Run the whole board test file**

Run:

```bash
pnpm test apps/web/src/features/board/BoardOverview.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit the UI change**

```bash
git add apps/web/src/features/board/BoardOverview.tsx apps/web/src/features/board/BoardOverview.test.ts apps/web/src/styles.css
git commit -m "Render batch refresh failure details"
```

---

### Task 3: Verify, Integrate, Deploy, And Publish Notes

**Files:**
- Verify only: all workspace packages
- Publish: production patch-note record through the existing authenticated admin flow

**Interfaces:**
- Consumes: completed Task 1 and Task 2 commits
- Produces: deployed `main`, successful production health check, and a public patch note

- [ ] **Step 1: Run repository verification**

```bash
pnpm check
pnpm test
pnpm test:d1-sql
pnpm build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run local desktop and mobile visual checks**

Start the web/API preview using the repository's established Pages preview command. Confirm the mixed-failure fixture shows the summary and list at desktop and 390px mobile width, with no overlap or horizontal overflow.

- [ ] **Step 3: Review the branch diff**

```bash
git diff main...HEAD --stat
git diff main...HEAD -- apps/web/src/features/board/BoardOverview.tsx apps/web/src/styles.css
```

Confirm no API, migration, or unrelated files changed.

- [ ] **Step 4: Merge and push**

From the main checkout, merge `codex/batch-refresh-failure-details`, confirm `main` matches `origin/main` after push, and preserve the unrelated untracked `image/` directory.

- [ ] **Step 5: Deploy production and smoke test**

Build and deploy the web package with:

```bash
pnpm --filter @riceark/web run deploy
```

Confirm the deployment source is the merged `main` SHA and `https://riceark.pages.dev/api/health` returns HTTP 200.

- [ ] **Step 6: Publish the patch note**

Use the existing admin patch-note form to publish one note covering:

```text
캐릭터 정보 갱신 개선

- 캐릭터 아이템 레벨과 전투력을 각각 잠가 자동 갱신 및 가져오기에서 유지할 수 있습니다.
- 캐릭터 정보 일괄 업데이트가 일부 실패하면 실패한 캐릭터와 사유를 함께 확인할 수 있습니다.
```

- [ ] **Step 7: Verify the public note and clean the worktree**

Confirm `/api/patch-notes` returns the new title and body, then remove the merged worktree and delete the merged feature branch.
