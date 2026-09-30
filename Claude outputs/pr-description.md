## What does this change?

Adds **groups** for organizing overrides. A group can hold overrides and other groups, nested as deep as you like.

**Groups**

- **+ Group** creates a group and lets you type its name right in the list. Double-click a name to rename it.
- Each group has an arrow to collapse or expand it. Doppel remembers which groups are collapsed.
- Each group has an on/off switch that pauses everything inside it, including sub-groups. Each override keeps its own switch, so turning the group back on restores exactly what was on before. Overrides paused this way are marked **paused by group**. The toolbar badge, the DevTools panel and page matching all respect this.
- Each group header shows how many overrides inside it are on (for example `2/3`), plus a **+ Override** button and a **⋯** menu. The menu has: new override here, new sub-group, rename, move to top/up/down, move to…, export this group, and delete. Delete asks whether to keep what's inside (it moves up one level) or delete everything.
- The override editor has a **Group** field.

**Ordering and moving**

- Groups and overrides share one order at each level, so an override can sit above a group. The priority order (which override wins) is what you see on screen, top to bottom.
- **Move to top** on each card and in the group menu. **Move up / Move down** step past groups as well as overrides. **Move to…** picks a group from a menu.
- Drag and drop:
  - The item you pick up folds out of the list, and a dashed slot shows where it will land, for example "Top of the list", "Top of “Payments”" or "Here, in “Wallet”".
  - The slot only moves when the landing spot actually changes, so it doesn't flicker.
  - Holding an item over a closed group opens it after a moment.
  - A group can't be dropped inside itself.

**Export and import**

- **Export…** opens a list of groups and overrides with checkboxes. Checking a group checks everything inside it, and a group shows a partial state when only some of its contents are checked.
- **Export this group** saves one group on its own as `doppel-<group-name>.json`, with that group at the top level of the file.
- Import keeps the groups in the file and gives items new ids if they clash with existing ones. Old flat export files still import.

**Folder sync and data**

- `doppel.json` now stores `groups` and each item's `sort` position (file format version 2).
- Existing overrides need no migration. Old files still load, and an older copy of Doppel reading a new file just sees a flat list.
- New storage key: `apiov_groups`. Collapsed groups are stored separately in `apiov_collapsed` and are not synced to the folder.

**Other**

- Light theme: switch dots and the text on coral buttons are now white.
- README: new **Groups** section.

Most of the new logic is in a new file, `lib/tree.js`. The shared ordering lives in `lib/match.js`, which is loaded by the background worker, the content bridge and every page.

## How did you test it?

- `npm test`: 23 unit tests pass. New tests in `tests/unit/tree.test.mjs` cover ordering, pausing through groups, moving and move to top, deleting a group with and without its contents, partial and single-group export, and importing when ids clash.
- `npm run test:e2e`: 35 tests pass. `tests/e2e/groups.test.mjs` is new and covers:
  - the nested list, collapsing (and remembering it), and the group switch against real requests
  - drag to a group, drag between items, drag to the very top, drag to the top level
  - Move to top, Move to…, and the editor's Group field
  - export dialog selection and single-group export
  - deleting a group while keeping its contents
  - a check that the drop slot never jumps back and forth while the pointer holds still (the old code failed it with 75 jumps)
- `tests/e2e/folder.test.mjs` now checks that groups survive a round trip through the folder.
- `npm run lint` and `npm run format:check` pass.
- Also checked by hand in Chrome (loaded unpacked).

Note: Playwright only sends drag events when the mouse button is released, so the tests that check the drop slot send the drag events directly instead of simulating a real mouse drag.

## Screenshots

| Light | Dark |
| ----- | ---- |
| _groups-light.png_ | _groups-dark.png_ |
| _drag-light.png_ | _drag-dark.png_ |
| _export-light.png_ | _export-dark.png_ |

## Checklist

- [x] Branch and commits follow the conventions in CONTRIBUTING.md
- [x] Tests added or updated for behavior changes
- [x] Screenshots for UI changes (light and dark mode)
- [ ] Linked issue, if there is one (e.g. `Fixes #12`)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_014ExJdFpqd2kY766HBKHkmH
