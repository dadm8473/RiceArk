# Drag Reorder Design

## Background

Users need to reorder both Lost Ark tasks and characters directly in the checklist matrix. RiceArk already stores character order on `characters.sort_order`, but default task templates are shared across users. Reordering shared template rows directly would mix one user's preference into everyone else's dashboard.

## Goals

- Let users reorder characters by dragging them in the matrix.
- Let users reorder tasks by dragging them in the matrix.
- Keep completion data stable while only changing presentation order.
- Support both orientations:
  - Tasks as rows, characters as columns.
  - Characters as rows, tasks as columns.
- Keep the roster column or row fixed at the beginning.
- Persist order per logged-in user.
- Make mobile drag work through pointer-based interactions.

## Non-Goals

- Dragging individual checklist cells.
- Dragging the special roster item.
- Cross-table drag behavior.
- Multi-select reorder.
- Keyboard reorder controls.

Keyboard controls can be added later for accessibility, but this first pass focuses on pointer drag behavior.

## Data Model

Character order continues to use the existing `characters.sort_order` column. The reorder endpoint only accepts character ids owned by the current user.

Task order uses a new per-user table:

- `task_orders`
  - `user_id`
  - `task_id`
  - `sort_order`
  - `updated_at`

`task_id` may point to either a shared template task or a user-owned task. The dashboard query orders tasks by `COALESCE(task_orders.sort_order, tasks.sort_order)` and then by task name.

This keeps shared templates immutable while allowing each user to keep their own task order.

## API

### Character Reorder

`PATCH /api/characters/order`

Request:

```json
{
  "characterIds": ["character-a", "character-b"]
}
```

Behavior:

- Validate every id belongs to the logged-in user.
- Ignore the roster item because it is not a real character.
- Write `sort_order` as `index * 10`.
- Reject unknown or duplicate ids.

### Task Reorder

`PATCH /api/tasks/order`

Request:

```json
{
  "taskIds": ["task-a", "task-b"]
}
```

Behavior:

- Validate every id is visible to the logged-in user: either `is_template = 1` or `user_id = current_user`.
- Write per-user order rows to `task_orders`.
- Reject unknown or duplicate ids.

## UI

Each draggable axis item gets a small drag handle. The handle appears next to the label, not on the checkbox cells.

In task-row orientation:

- Task row headers are draggable.
- Character column headers are draggable.
- The roster column is fixed.

In task-column orientation:

- Task column headers are draggable.
- Character row headers are draggable.
- The roster row is fixed.

The UI keeps local order during drag so the matrix responds immediately. The app calls the reorder API only after the drag ends. If saving fails, the dashboard is reloaded so the server order wins.

## Pointer Drag

Use Pointer Events rather than HTML drag and drop. HTML drag and drop is unreliable on mobile browsers.

The implementation tracks:

- Drag group: `task` or `character`.
- Active item id.
- Original index.
- Current pointer position.
- Candidate index under the pointer.

When the pointer crosses another draggable item on the same axis, the array is reordered locally. On pointer up, the new order is sent to the correct API.

## Safety Rules

- Reorder never changes `task_id`, `character_id`, or `period_key`.
- Reorder does not touch completion rows.
- Reorder does not use displayed label or optional character display name as identity.
- Roster stays fixed and is excluded from reorder payloads.
- Failed saves reload the dashboard instead of keeping an uncertain local order.

## Testing

Backend:

- Character reorder accepts only owned character ids.
- Character reorder rejects duplicate ids.
- Task reorder accepts template and user task ids visible to the user.
- Task reorder rejects unknown ids.
- Dashboard orders tasks by user-specific `task_orders` before default task order.

Frontend:

- Matrix renders drag handles for task and character axis items.
- Roster does not render a drag handle.
- Reorder helper moves an item from one index to another.
- Drag-end handlers call the correct API with ids only, not labels.
