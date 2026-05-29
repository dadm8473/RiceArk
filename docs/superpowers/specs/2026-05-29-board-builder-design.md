# RiceArk Board Builder Design

## Background

RiceArk started as a Lost Ark daily and weekly checklist matrix. The product direction is now a small spreadsheet or board builder that can host Lost Ark checklist data.

The app should still feel fast and simple for a Lost Ark user who wants the default checklist, but the underlying model must not assume that characters are always columns or that tasks are always rows.

## Product Goals

- Let a user create multiple sheets.
- Let each sheet contain multiple checklist tables.
- Let each table choose whether characters are rows or columns.
- Let first-time users choose whether the default table uses characters as columns or tasks as columns.
- Let users create tables that do not use characters at all.
- Let users create rows and columns manually.
- Keep first-version cells simple: checkbox cells only.
- Let each cell hide its checkbox when that row and column combination does not apply.
- Support optional character display names such as `냠1`, without requiring every user to configure aliases.
- Show compact names in dense tables while keeping real character details available through hover on desktop and tap on mobile.
- Preserve Lost Ark reset behavior for daily, weekly, biweekly, and custom schedules using `Asia/Seoul`.

## Non-Goals For The First Board Builder Version

- Full spreadsheet formulas.
- Rich text cells.
- Arbitrary drag-and-drop canvas positioning.
- Multi-user collaborative editing.
- Per-cell custom reset rules.
- PWA support.
- CSV export.
- Advanced icon customization beyond using the app icon and future character/task icons.

These remain valid future backlog items, but they should not be included in the first board builder implementation.

## Concepts

### Sheet

A sheet is a top-level tab, similar to a spreadsheet tab. A user can create multiple sheets for different purposes, such as raids, roster-wide chores, events, or custom tracking.

Every user starts with one default sheet.

### Table

A table belongs to one sheet. A sheet can contain multiple tables stacked vertically in the first version. This avoids a complex canvas layout while still letting one screen show several independent checklists.

A table has:

- Name.
- Sort order within the sheet.
- Row axis configuration.
- Column axis configuration.
- Row role: `character`, `task`, or `custom`.
- Column role: `character`, `task`, or `custom`.
- Default row height.
- Default column width.
- Optional default reset rule for non-task tables.

### Axis Item

Rows and columns share the same item model. Each axis item belongs to a table and one axis: `row` or `column`.

An axis item has:

- Label.
- Kind: `character`, `task`, or `custom`.
- Optional linked character id.
- Optional linked task metadata.
- Width or height, depending on axis.
- Sort order.
- Visibility.

This keeps the model flexible enough for:

- Task rows and character columns.
- Character rows and task columns.
- Custom rows and custom columns.
- A simple table that only uses custom labels.

### Orientation And Data Safety

Table orientation is user-controlled, but orientation changes must never reinterpret existing data by position or label.

On first use, the app asks the user to choose the default Lost Ark table orientation:

- Characters as columns, tasks as rows.
- Tasks as columns, characters as rows.

The chosen orientation is saved on the default table. Future tables can choose their own orientation.

Changing an existing table's orientation is a controlled transpose operation, not a simple settings toggle. The app must:

- Preserve the original table until the transpose is complete.
- Match data by stable linked ids, such as character id and task id, not by displayed label or current order.
- Create new row and column axis items for the transposed orientation.
- Copy cell visibility and completion state to the matching transposed cell.
- Keep hidden cells hidden after transposition.
- Show a preview or confirmation before applying the change.
- Block or warn on unsafe transposition when custom axis items cannot be matched without ambiguity.

This is especially important because a user may later rename rows, set optional character display names, reorder items, or resize axes. None of those presentation changes may affect completion identity.

### Task Metadata

Task metadata can be attached to either row or column axis items.

Task metadata includes:

- Reset type: daily, weekly, biweekly, custom, or none.
- Scope: character, roster, or custom.
- Reset anchor and interval data.
- Display label.

For a Lost Ark checklist table, the table records which axis is the task axis: `rows`, `columns`, or `none`.

When the task axis is `rows`, each cell gets its reset period from the row item. When the task axis is `columns`, each cell gets its reset period from the column item. When the task axis is `none`, the table default reset rule is used if present, otherwise the cell is treated as non-resetting manual state.

### Cell

The first version has checkbox-only cells.

A cell has:

- Row item id.
- Column item id.
- Checkbox visibility.
- Completion state for the current reset period.

Cell checkbox visibility states:

- `visible`: show the checkbox.
- `hidden`: this row and column combination does not apply.

Hidden cells are excluded from completion counts and reset handling. They can be shown again later.

## Character Display Names

Character aliases are optional.

Each character keeps its real Lost Ark name. A user may optionally set a display name. If a display name exists, dense tables show that value. If not, tables show the real character name.

Examples:

- Real name: `냠수나이스1`.
- Optional display name: `냠1`.
- Table header or row label: `냠1`.
- Hover or tap details: server, real nickname, class, item level, combat power.

This must never break character identity. API calls, duplicate detection, and saved links use the real character data, not the display name.

## Initial UX

### Dashboard Structure

The dashboard shows:

1. Top bar with the app identity, round app icon, auth menu, and primary actions.
2. Sheet tabs.
3. Active sheet content.
4. One or more tables inside the active sheet.

For the first board builder release, tables are stacked vertically. Each table owns its own horizontal scroll area so a wide table does not break the entire page layout.

### Default Table

New users choose the default Lost Ark checklist orientation during first setup:

- Characters as columns and tasks as rows.
- Tasks as columns and characters as rows.

Existing users receive the current checklist orientation when migrated:

- Task axis: rows.
- Character axis: columns.
- Existing tasks become task row items.
- Existing imported characters become character column items.
- Existing completion data is migrated or mapped into cell completion state.

Users can later create another table with a different orientation, or use a guarded transpose flow to change an existing table.

### Table Controls

Each table has compact controls:

- Rename table.
- Add row.
- Add column.
- Add character row or column from imported characters.
- Add task row or column.
- Hide or show a cell checkbox.

The first implementation can use modals or small inline menus rather than drag-and-drop editing.

### Cell Interaction

Primary click or tap toggles completion when the checkbox is visible.

A secondary action opens a small cell menu with:

- Hide checkbox.
- Show checkbox if hidden.

On desktop this can be a right-click or small contextual button. On mobile it should be reachable through a tap target, not hover.

### Character Details

For character axis items:

- Desktop hover shows a small detail popover.
- Mobile tap shows the same information in a lightweight popover or menu.
- The compact label uses the optional display name when present.

## Layout Rules

The first board builder version should prioritize predictable layout over freeform placement.

- Sheet tabs sit above the active sheet.
- Tables stack vertically.
- Each table has square corners.
- Table cells use stable row heights and column widths.
- Width and height values are saved per axis item.
- Users can edit row height and column width through numeric controls or a simple size menu.
- Direct drag resizing can be added later after the data model is stable.
- Mobile uses horizontal scroll per table.

This gives users practical control without introducing a fragile freeform canvas too early.

## Data Model Direction

New tables should be added without removing the existing auth, character import, and reset calculation code.

Planned entities:

- `sheets`
- `tables`
- `axis_items`
- `cells`
- `cell_completions`

Existing entities remain:

- `users`
- `oauth_accounts`
- `sessions`
- `characters`
- `tasks`
- `user_settings`

The `characters` table gains an optional display name field.

The existing `tasks` table can stay as reusable task templates or be gradually folded into task axis metadata. For the first migration, existing tasks should become task axis items in the default table while the old task records remain available for compatibility during migration.

## Completion Keys

Completion state should be keyed by:

- User id.
- Table id.
- Row item id.
- Column item id.
- Period key.

The period key is derived from the task axis item or table default reset rule.

This keeps completions stable whether the table is task-row/character-column or character-row/task-column.

For orientation changes, completion migration must map from the old cell to the new cell using stable linked ids. A completion for the pair `character A + task B` remains that same semantic pair after transpose, even though the row and column ids change.

## Migration Strategy

1. Add new board tables and optional character display names.
2. Create a default sheet and default table for each user that has existing dashboard data.
3. For new users, create the default table only after the first-use orientation choice.
4. Convert existing tasks into row axis items in the default table.
5. Convert existing characters into column axis items in the default table.
6. Copy or map current completion state into the new cell completion structure.
7. Keep read compatibility until the new dashboard endpoint is fully switched.

The app should avoid destructive migration steps until the new model is verified locally and against preview data.

## API Direction

Dashboard loading should still use one main endpoint for cost and speed.

The dashboard payload should include:

- Sheets.
- Active or default sheet id.
- Tables for the active sheet.
- Axis items for each table.
- Current-period cell states.
- Imported characters.
- User settings.

Mutation endpoints should be small and explicit:

- Create, rename, reorder, and delete sheets.
- Create, rename, reorder, and delete tables.
- Create, update, reorder, and delete axis items.
- Update cell completion.
- Update cell visibility.
- Update character display name.
- Transpose table orientation through a guarded migration flow.

Batching should still be used for rapid checkbox changes.

## Testing

Backend tests:

- Existing user receives a default sheet and table.
- New user setup can create a default table in either orientation.
- Task rows and character columns produce the same completion behavior as the current matrix.
- Character rows and task columns produce correct period keys.
- Orientation transpose maps completions by stable character and task ids.
- Orientation transpose preserves hidden cells.
- Hidden cells are excluded from completion counts.
- Optional character display name falls back to real name when empty.
- Daily, weekly, biweekly, and custom reset rules still use `Asia/Seoul`.

Frontend tests:

- First setup asks whether characters or tasks should be columns.
- Dashboard renders sheet tabs and at least one table.
- Compact character label uses display name when set.
- Compact character label falls back to real name.
- Character detail popover contains real nickname, server, class, item level, and combat power.
- Hidden cells do not render checkboxes.
- Checkbox toggles still call the completion mutation.

## Rollout Plan

The implementation should be split into phases:

1. Add optional character display names and compact character details.
2. Add board data model, first-use orientation choice, and default sheet/table creation.
3. Render the current checklist through the new table model.
4. Add sheet and table creation controls.
5. Add row and column creation controls.
6. Add cell checkbox visibility controls.
7. Add row height and column width editing.
8. Add guarded table orientation transpose.

This keeps each deployment usable and makes it easier to verify that existing checklist behavior survives the transition.
