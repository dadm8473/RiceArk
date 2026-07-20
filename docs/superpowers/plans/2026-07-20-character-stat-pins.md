# Character Stat Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independent item-level and combat-power pins that block every automatic character update while preserving direct edits, then merge and deploy the verified change to production.

**Architecture:** Store two constrained integer flags on `characters`, project them through existing board reads, and enforce them in D1 write statements rather than relying on client behavior. Character mutation and refresh endpoints expose camel-case booleans; the board payload retains its existing snake-case `0 | 1` convention. The character axis edit modal saves both values and flags in the existing PATCH, so the feature adds no API calls.

**Tech Stack:** TypeScript, React, Hono, Zod, Cloudflare D1/Pages Functions, Vitest, Node SQLite, Lucide React, pnpm.

## Global Constraints

- Item level and combat power are pinned independently.
- Pins protect individual refresh, batch refresh, saved-character import/re-registration, and table-scoped import.
- Direct edits remain allowed and preserve the selected pin state.
- Disabling a pin does not trigger an immediate refresh.
- Do not render pin state in board table headers or shared read-only boards.
- Do not add a network request; use existing board loads, character saves, and refresh responses.
- Refresh responses must contain committed effective values after current pin state is applied.
- Preserve existing batch limits, cooldowns, statement budgets, partial failures, and version semantics.

---

### Task 1: Persist And Project Independent Pin Flags

**Files:**
- Create: `apps/api/migrations/0027_character_stat_pins.sql`
- Modify: `apps/api/src/db/schema.test.ts`
- Modify: `apps/api/src/db/boardReads.ts`
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/api/src/db/boardReads.test.ts`
- Modify: `apps/api/src/routes/board.test.ts`
- Modify: `apps/web/src/features/board/types.ts`

**Interfaces:**
- Produces database columns `item_level_pinned` and `combat_power_pinned` as constrained `0 | 1` integers.
- Produces board payload fields `character_item_level_pinned?: 0 | 1` and `character_combat_power_pinned?: 0 | 1`.

- [ ] **Step 1: Write failing schema and board-read tests**

Add schema assertions for both defaulted constrained columns, extend all SQLite character fixtures with the columns, and assert a projected character axis item contains independent values:

```ts
expect(migration).toContain("item_level_pinned INTEGER NOT NULL DEFAULT 0");
expect(migration).toContain("item_level_pinned IN (0, 1)");
expect(migration).toContain("combat_power_pinned INTEGER NOT NULL DEFAULT 0");
expect(migration).toContain("combat_power_pinned IN (0, 1)");

expect(characterAxis).toMatchObject({
  character_item_level_pinned: 1,
  character_combat_power_pinned: 0
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run apps/api/src/db/schema.test.ts apps/api/src/db/boardReads.test.ts apps/api/src/routes/board.test.ts`

Expected: FAIL because migration columns and board projection fields do not exist.

- [ ] **Step 3: Add migration and board projections**

Create the migration:

```sql
ALTER TABLE characters ADD COLUMN item_level_pinned INTEGER NOT NULL DEFAULT 0
  CHECK (item_level_pinned IN (0, 1));
ALTER TABLE characters ADD COLUMN combat_power_pinned INTEGER NOT NULL DEFAULT 0
  CHECK (combat_power_pinned IN (0, 1));
```

Add both columns to `BoardAxisItemRow`, every character-bearing board SELECT, and the web `BoardAxisItem` type:

```ts
character_item_level_pinned?: 0 | 1 | undefined;
character_combat_power_pinned?: 0 | 1 | undefined;
```

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm vitest run apps/api/src/db/schema.test.ts apps/api/src/db/boardReads.test.ts apps/api/src/routes/board.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit persistence and projection**

```bash
git add apps/api/migrations/0027_character_stat_pins.sql apps/api/src/db/schema.test.ts apps/api/src/db/boardReads.ts apps/api/src/db/board.ts apps/api/src/db/boardReads.test.ts apps/api/src/routes/board.test.ts apps/web/src/features/board/types.ts
git commit -m "Add character stat pin storage"
```

### Task 2: Save Pins Through The Character Detail API

**Files:**
- Modify: `apps/api/src/routes/characters.ts`
- Modify: `apps/api/src/routes/characters.test.ts`
- Modify: `apps/api/src/routes/characters.refresh.test.ts`
- Modify: `apps/api/src/db/characters.ts`
- Modify: `apps/api/src/db/characters.test.ts`

**Interfaces:**
- Consumes database flags from Task 1.
- Produces `itemLevelPinned?: boolean` and `combatPowerPinned?: boolean` on `characterDetailsSchema`.
- Produces a character mutation result containing effective boolean pin values in addition to existing mutation versions.

- [ ] **Step 1: Write failing schema and database mutation tests**

Prove booleans are accepted, strings/numbers are rejected, omitted fields preserve stored flags, and direct edits can update a pinned stat:

```ts
expect(characterDetailsSchema.safeParse({
  displayName: null,
  itemLevel: "1,700.00",
  combatPower: "3,000.00",
  itemLevelPinned: true,
  combatPowerPinned: false
}).success).toBe(true);

expect(characterDetailsSchema.safeParse({
  displayName: null,
  itemLevel: "1,700.00",
  combatPower: null,
  itemLevelPinned: 1
}).success).toBe(false);
```

Database assertions must verify stored values and returned fields:

```ts
expect(result).toMatchObject({ itemLevelPinned: true, combatPowerPinned: false });
expect(database.prepare(
  "SELECT item_level, combat_power, item_level_pinned, combat_power_pinned FROM characters WHERE id = ?"
).get("character-1")).toEqual({
  item_level: "1,700.00",
  combat_power: "3,000.00",
  item_level_pinned: 1,
  combat_power_pinned: 0
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run apps/api/src/routes/characters.test.ts apps/api/src/routes/characters.refresh.test.ts apps/api/src/db/characters.test.ts`

Expected: FAIL because pin inputs and return fields are absent.

- [ ] **Step 3: Extend validation and atomic detail mutation**

Add optional booleans to the strict schema. Extend `updateCharacterDetails` input with optional booleans and use omission guards so older clients preserve current flags:

```sql
item_level_pinned = CASE WHEN ? = 1 THEN ? ELSE item_level_pinned END,
combat_power_pinned = CASE WHEN ? = 1 THEN ? ELSE combat_power_pinned END
```

Return `id`, `item_level_pinned`, and `combat_power_pinned` from the same update statement, convert them to booleans, and keep sheet versions in the response. The route passes omitted values through without defaulting them.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm vitest run apps/api/src/routes/characters.test.ts apps/api/src/routes/characters.refresh.test.ts apps/api/src/db/characters.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit API mutation support**

```bash
git add apps/api/src/routes/characters.ts apps/api/src/routes/characters.test.ts apps/api/src/routes/characters.refresh.test.ts apps/api/src/db/characters.ts apps/api/src/db/characters.test.ts
git commit -m "Support character stat pin updates"
```

### Task 3: Preserve Pins In Both Import Paths And Version Only Effective Changes

**Files:**
- Modify: `apps/api/src/db/characters.ts`
- Modify: `apps/api/src/db/characters.test.ts`
- Modify: `apps/api/src/db/board.ts`
- Modify: `apps/api/src/db/board.test.ts`
- Modify: `apps/api/src/db/boardVersions.ts`
- Modify: `apps/api/src/db/boardVersions.test.ts`

**Interfaces:**
- Consumes stored flags from Task 1.
- Produces identical field-level preservation behavior for `saveSelectedCharacters` and `importBoardCharactersForTable`.
- Produces import version comparisons based on effective values.

- [ ] **Step 1: Write failing import and version tests**

Seed four characters covering independent and combined pins. Import different upstream values and assert only unpinned fields change. Assert ignored pinned values do not bump referenced sheets, while class/reactivation changes still do:

```ts
expect(readStats(database, "level-pinned")).toEqual({
  item_level: "1,640.00",
  combat_power: "3,100.00",
  item_level_pinned: 1,
  combat_power_pinned: 0
});
expect(readStats(database, "power-pinned")).toEqual({
  item_level: "1,710.00",
  combat_power: "2,500.00",
  item_level_pinned: 0,
  combat_power_pinned: 1
});
```

Repeat the same behavior through `importBoardCharactersForTable` and assert new rows default to both flags off.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run apps/api/src/db/characters.test.ts apps/api/src/db/board.test.ts apps/api/src/db/boardVersions.test.ts`

Expected: FAIL because both upserts overwrite pinned values and version SQL compares raw values.

- [ ] **Step 3: Guard both upserts and version comparisons**

Change both conflict updates to field-level CASE expressions without assigning either pin flag:

```sql
item_level = CASE
  WHEN characters.item_level_pinned = 1 THEN characters.item_level
  ELSE excluded.item_level
END,
combat_power = CASE
  WHEN characters.combat_power_pinned = 1 THEN characters.combat_power
  ELSE excluded.combat_power
END
```

Change `bumpBoardSheetVersionsForCharacterImportStatement` comparisons to ignore incoming values for pinned fields:

```sql
OR (characters.item_level_pinned = 0 AND characters.item_level IS NOT valid_input.item_level)
OR (characters.combat_power_pinned = 0 AND characters.combat_power IS NOT valid_input.combat_power)
```

Keep class/source/enabled/deletion checks unchanged.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm vitest run apps/api/src/db/characters.test.ts apps/api/src/db/board.test.ts apps/api/src/db/boardVersions.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit automatic import enforcement**

```bash
git add apps/api/src/db/characters.ts apps/api/src/db/characters.test.ts apps/api/src/db/board.ts apps/api/src/db/board.test.ts apps/api/src/db/boardVersions.ts apps/api/src/db/boardVersions.test.ts
git commit -m "Preserve pinned stats during imports"
```

### Task 4: Return Effective Values From Individual And Batch Refresh

**Files:**
- Modify: `apps/api/src/db/characters.ts`
- Modify: `apps/api/src/db/characters.test.ts`
- Modify: `apps/api/src/routes/characters.refresh.test.ts`

**Interfaces:**
- Extends `CharacterSnapshot` with `itemLevelPinned: boolean` and `combatPowerPinned: boolean`.
- `refreshCharactersFromLostArk` returns the values and flags committed by D1 for each updated character.
- `updateCharacterFromLostArk` inherits the same effective response for individual refresh.

- [ ] **Step 1: Write failing refresh tests for all pin combinations**

Use SQLite-backed refresh tests for unpinned, level-only, power-only, and both-pinned characters. Assert database state and response state agree:

```ts
expect(updated.character).toMatchObject({
  itemLevel: "1,640.00",
  combatPower: "3,100.00",
  itemLevelPinned: true,
  combatPowerPinned: false
});
```

Add a scripted race test that changes `item_level_pinned` after the external profile resolves but before the update executes, then assert the current database pin wins.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm vitest run apps/api/src/db/characters.test.ts apps/api/src/routes/characters.refresh.test.ts`

Expected: FAIL because refresh writes and returns raw upstream stats.

- [ ] **Step 3: Make the refresh statement pin-aware and return committed rows**

Use CASE expressions evaluated inside the update:

```sql
item_level = CASE
  WHEN item_level_pinned = 1 THEN item_level
  ELSE (SELECT item_level FROM valid_input WHERE valid_input.id = characters.id)
END,
combat_power = CASE
  WHEN combat_power_pinned = 1 THEN combat_power
  ELSE (SELECT combat_power FROM valid_input WHERE valid_input.id = characters.id)
END
RETURNING id, name, server_name, class_name, item_level, combat_power,
          item_level_pinned, combat_power_pinned
```

Parse every returned row, reject incomplete/mismatched sets with the existing guard/retry mechanism, and build updated results from returned rows rather than `success.profile`. Update refresh version SQL with the same effective-change conditions.

- [ ] **Step 4: Run focused tests and verify pass**

Run: `pnpm vitest run apps/api/src/db/characters.test.ts apps/api/src/routes/characters.refresh.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit refresh consistency**

```bash
git add apps/api/src/db/characters.ts apps/api/src/db/characters.test.ts apps/api/src/routes/characters.refresh.test.ts
git commit -m "Respect stat pins during character refresh"
```

### Task 5: Add Accessible Pin Toggles To Character Editing

**Files:**
- Modify: `apps/web/src/features/board/BoardOverview.tsx`
- Modify: `apps/web/src/features/board/BoardOverview.test.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes board integer flags and character mutation/refresh booleans.
- Extends `BoardCharacterSaveInput` and `BoardCharacterRefreshResult` with boolean pin fields.
- Produces two independent icon-only `aria-pressed` toggles inside `BoardAxisItemEditModal`.

- [ ] **Step 1: Write failing helper, render, save, and refresh projection tests**

Extend helper and state projection tests so a pin-only change is dirty and refresh results copy flags:

```ts
expect(shouldSaveBoardCharacterDetails(
  characterItem,
  "냠1",
  "1,778.33",
  "2,549.41",
  undefined,
  undefined,
  undefined,
  true,
  false
)).toBe(true);

expect(updatedItem).toMatchObject({
  character_item_level_pinned: 1,
  character_combat_power_pinned: 0
});
```

Render the modal and assert two buttons have titles/accessibility labels `레벨 자동 갱신 잠금` and `전투력 자동 갱신 잠금`, correct `aria-pressed`, and the table header markup remains unchanged.

- [ ] **Step 2: Run focused web tests and verify failure**

Run: `pnpm vitest run apps/web/src/features/board/BoardOverview.test.ts`

Expected: FAIL because pin props, controls, and local projection updates are absent.

- [ ] **Step 3: Implement local state, existing PATCH transport, and compact controls**

Initialize state with `item.character_item_level_pinned === 1` and its combat-power equivalent. Place each input and pin button in a stable row:

```tsx
<span className="character-stat-edit-row">
  <input value={characterItemLevel} onChange={...} />
  <button
    aria-label="레벨 자동 갱신 잠금"
    aria-pressed={characterItemLevelPinned}
    className="character-stat-pin-button"
    title="레벨 자동 갱신 잠금"
    type="button"
    onClick={() => setCharacterItemLevelPinned((current) => !current)}
  >
    <Pin aria-hidden="true" size={15} />
  </button>
</span>
```

Send both booleans in the existing save PATCH. Copy effective flags from save, individual refresh, and batch refresh responses to every matching axis item as `1 | 0`. Style a fixed 32px icon button with a clear neutral inactive state, accent active state, focus-visible outline, and dark-theme parity; keep the three-column modal layout responsive.

- [ ] **Step 4: Run focused web tests and verify pass**

Run: `pnpm vitest run apps/web/src/features/board/BoardOverview.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the character edit UI**

```bash
git add apps/web/src/features/board/BoardOverview.tsx apps/web/src/features/board/BoardOverview.test.ts apps/web/src/styles.css
git commit -m "Add character stat pin controls"
```

### Task 6: Verify, Merge, Migrate, And Deploy Production

**Files:**
- Modify only files required by verification findings.

**Interfaces:**
- Consumes all preceding tasks.
- Produces a verified main-branch commit, applied production migration, Pages deployment, and production smoke evidence.

- [ ] **Step 1: Run static and full automated verification**

Run:

```bash
pnpm check
pnpm test
pnpm test:d1-sql
pnpm build
git diff --check main...HEAD
```

Expected: all commands exit 0; no whitespace errors.

- [ ] **Step 2: Run local Pages UI smoke test**

Start the local app using the repository's established Pages/Vite flow. Open an imported and manual character edit modal at desktop and mobile widths. Verify two independent controls, no layout overlap, pin-only save, direct edit while pinned, refresh preservation, no table-header indicator, and no extra request beyond the existing PATCH/refresh calls.

Expected: controls remain readable and keyboard-focusable; network and UI state match the design.

- [ ] **Step 3: Review branch and commit any verification fixes**

Run: `git status --short && git log --oneline main..HEAD`

Expected: only intended commits and no uncommitted files. If verification required a fix, rerun its focused test and commit only that fix before repeating Step 1.

- [ ] **Step 4: Merge and push main**

From `/Users/jsb/Documents/PG/RiceArk`, verify unrelated local files are untouched, fast-forward or merge `codex/character-stat-pins` into `main`, and push:

```bash
git merge --no-ff codex/character-stat-pins -m "Merge character stat pins"
git push origin main
```

Expected: `origin/main` resolves to the merge commit and the unrelated untracked `image/` directory remains unchanged.

- [ ] **Step 5: Inspect and apply the production D1 migration**

Run:

```bash
pnpm --filter @riceark/api exec wrangler d1 migrations list riceark --remote
pnpm --filter @riceark/api exec wrangler d1 migrations apply riceark --remote
```

Expected: `0027_character_stat_pins.sql` is initially pending, applies successfully once, and is no longer pending.

- [ ] **Step 6: Deploy the Pages production bundle**

Run: `pnpm deploy:web`

Expected: Wrangler reports a successful production deployment for the `riceark` Pages project. Do not deploy the standalone `riceark-api` Worker because production API traffic is served by `apps/web/functions/api/[[path]].ts`.

- [ ] **Step 7: Smoke test production and verify deployed source**

Verify `https://riceark.pages.dev/api/health` returns HTTP 200 with the expected service payload, load the production board, edit both pin states, refresh once, and confirm pinned values remain unchanged. Confirm the deployed Pages revision corresponds to the pushed main commit and inspect production logs for new 5xx errors.

Expected: health is 200, the feature works end to end, and no new server errors appear.

- [ ] **Step 8: Complete the goal with deployment evidence**

Record the merge SHA, pushed branch, migration result, Pages deployment URL/id, production health result, and full verification counts in the final report. Mark the goal complete only after every production check succeeds.
