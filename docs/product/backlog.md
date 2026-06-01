# RiceArk Product Backlog

This is a parking lot for future ideas the owner wants to revisit later.
Items here are not yet designed, prioritized, or scheduled.

## Future Feature Ideas

- Sub-account support: allow one user to manage additional accounts or rosters separately.
- Donation button: add a lightweight support/donation entry point.
- Icon settings: let users configure icons for tasks, characters, tables, or shortcuts.
- Character display aliases: keep the real character name for API/storage, but let users set a custom short label such as `냠1` for easier table scanning.
- Additional tables: allow users to add separate checklist tables for categories such as roster-wide tasks.
- Manual character creation: let users add a character manually when API search does not find it or when a temporary/custom character is needed.
- Templates: provide reusable task/table presets users can apply to their checklist.
- CSV export: export checklist data, characters, tasks, or completion state as CSV.
- PWA support: make the site installable and more app-like on desktop/mobile.

## Notes

- Table layout customization should be treated as a larger feature than the current density controls. It should cover per-column width, per-row height, sheet tabs, board placement, and adding/managing multiple tables.
- The preferred board-builder direction is a sheet tab plus board canvas where multiple content-sized tables can be placed in one sheet.
- Final checklist grids should use compact checkbox boxes rather than full bordered spreadsheet cells.
- Task separators should exist by default, while character separators should be optional and user-configurable.
- Task colors should drive checkbox color so dense checklists remain scannable.
- Layout and visual customization state must stay separate from semantic completion state so resizing, moving, recoloring, or adding separators does not corrupt saved checklist data.
- Character aliases should not replace the real character name used for Lost Ark API matching.
