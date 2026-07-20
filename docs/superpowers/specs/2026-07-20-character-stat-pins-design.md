# Character Stat Pins Design

## Goal

Allow each saved character's item level and combat power to be pinned independently. A pinned value remains unchanged across every automatic Lost Ark update path, while direct user edits remain available.

## User Experience

The character axis-item edit modal adds one icon-only pin toggle beside the item-level input and one beside the combat-power input.

- Each toggle has an explicit accessible name and tooltip: `레벨 자동 갱신 잠금` and `전투력 자동 갱신 잠금`.
- The active state uses `aria-pressed`, a filled accent treatment, and the existing Lucide `Pin` icon.
- The pin controls are available for imported and manual characters because a later re-import can match and reactivate either record.
- Directly editing a pinned value is allowed and preserves the active pin.
- Turning a pin off does not fetch data immediately. The next explicit or batch refresh may replace that value.
- The board table itself does not display pin indicators.
- Read-only shared boards do not expose pin controls.

## Data Model

Migration `0027_character_stat_pins.sql` adds two non-null integer columns to `characters`:

```sql
item_level_pinned INTEGER NOT NULL DEFAULT 0 CHECK (item_level_pinned IN (0, 1))
combat_power_pinned INTEGER NOT NULL DEFAULT 0 CHECK (combat_power_pinned IN (0, 1))
```

Existing characters remain unpinned. Soft deletion and later re-import preserve the existing pin values because the existing character row is reactivated rather than replaced.

## API Contract

Character detail updates accept two optional booleans:

```ts
{
  itemLevelPinned?: boolean;
  combatPowerPinned?: boolean;
}
```

Omitted fields preserve the stored pin state, keeping older clients compatible. The character edit modal sends both values whenever it saves character details.

Character-detail mutation and refresh responses expose the effective pin state:

```ts
{
  itemLevelPinned: boolean;
  combatPowerPinned: boolean;
}
```

The database and existing `snake_case` board payload projection continue to use `0 | 1`. Character-detail mutation and refresh response fields use camel-case booleans. The web client normalizes the board projection to booleans when initializing the edit controls.

## Automatic Update Rules

The server enforces pins in every automatic write path:

1. Individual Lost Ark refresh.
2. Batch Lost Ark refresh.
3. Saved-character import and re-registration.
4. Table-scoped character import.

For an existing character:

- `class_name` and other non-pinnable automatic fields continue to update.
- `item_level` updates only when `item_level_pinned = 0`.
- `combat_power` updates only when `combat_power_pinned = 0`.
- Automatic imports never clear either pin.
- Newly inserted characters use both default pin values of `0`.

Manual character detail updates are not automatic writes. They may change the value and pin state together regardless of the previous pin state.

## Refresh Consistency

Refresh responses must contain the values that were actually committed, not the raw Lost Ark profile values. The set-based refresh update returns each stored character row after applying its current pins. This prevents a pinned field from briefly showing the external value before reverting on the next board load.

Pin decisions are evaluated by the write statement after the external request finishes. If another tab changes a pin while the request is in flight, the latest stored pin state wins.

The batch response remains one result per requested character and keeps the current concurrency, cooldown, statement-budget, partial-failure, and version semantics.

## Board Versions And Caching

Changing a value or either pin state is a character mutation and bumps every sheet that references the character. This allows open tabs and shared detail views to revalidate consistently.

Automatic import and refresh version statements compare effective values:

- A different incoming pinned value alone is not a board-content change.
- A non-pinned field change remains a board-content change.
- Class, source, enabled, and deletion-state changes keep their existing behavior.

No additional API request is introduced. Pins travel through existing board loads, character detail saves, and refresh responses.

## Client State

Board axis-item projections add:

```ts
character_item_level_pinned?: 0 | 1;
character_combat_power_pinned?: 0 | 1;
```

The edit modal initializes local toggle state from these fields. Saving updates every axis item that references the character. Individual and batch refresh application also copies the effective values and pin states returned by the API.

## Error Handling

- Invalid pin values fail Zod validation before reaching D1.
- Missing characters retain the existing `404 character_not_found` response.
- Refresh failures and rate limits retain their existing response shapes.
- A pin-only save uses the existing mutation barrier and error display.

## Testing

Automated coverage will prove:

- The migration adds both constrained columns with unpinned defaults.
- Character detail schema accepts booleans, rejects non-booleans, and preserves omitted states.
- Direct edits can change pinned values and pin state together.
- Each import path preserves item level and combat power independently.
- Individual and batch refreshes return committed effective values for every pin combination.
- A pin changed during an in-flight refresh is respected by the update statement.
- Version bumps occur for pin changes and effective automatic value changes, but not for ignored incoming pinned values.
- Board payloads expose both flags and the edit modal renders two independent, accessible pin toggles.
- Saving and refresh application update the local axis-item projection without adding network requests.

Full verification runs `pnpm check`, `pnpm test`, `pnpm test:d1-sql`, and `pnpm build`, followed by a local Pages UI smoke test of the character edit modal.

## Non-Goals

- Pinning server, class, nickname, or display name.
- Showing pin icons in board headers or shared tables.
- Background refresh when a pin is disabled.
- Keeping a separate hidden copy of the latest Lost Ark value.
