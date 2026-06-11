# RiceArk Product Backlog

This is a parking lot for future ideas the owner wants to revisit later.
Items here are not yet designed, prioritized, or scheduled.

## Future Feature Ideas

- Donation button: add a lightweight support/donation entry point.
- Dark mode (Beta): support a comfortable dark UI for long checklist sessions.
- Custom themes: let users customize table/app colors beyond the default palette.
- Templates: provide reusable task/table presets users can apply to their checklist.
- CSV export: export checklist data, characters, tasks, or completion state as CSV.
- PWA support: make the site installable and more app-like on desktop/mobile.
- Admin dashboard roadmap: expand the current read-only operations view into cost/capacity tracking, health checks, support tools, alerts, and safe admin controls. See `docs/product/admin-dashboard-roadmap.md`.

## Notes

- Table layout customization should be treated as a larger feature than the current density controls. It should cover per-column width, per-row height, sheet tabs, board placement, and adding/managing multiple tables.
- The preferred board-builder direction is a sheet tab plus board canvas where multiple content-sized tables can be placed in one sheet.
- Task separators should exist by default, while character separators should be optional and user-configurable.
- Layout and visual customization state must stay separate from semantic completion state so resizing, moving, recoloring, or adding separators does not corrupt saved checklist data.
- Row/column switching must be a guarded transpose with preview. Completion state, hidden cells, task colors, reset rules, and safe separators must move by stable ids, never by visible label or grid position.
- Task creation should be single-flight: disable or debounce the add button while a create request is pending so rapid repeated clicks cannot create duplicate tasks.
- Task creation should eventually offer a few preset task options so users can add common Lost Ark homework entries quickly.
