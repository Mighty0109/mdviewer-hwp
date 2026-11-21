# DragHandle

Mount the named extension in the editable TipTap editor:

```ts
import { DragHandle } from '@/extensions/drag-handle';
// extensions: [...existingExtensions, DragHandle]
```

The extension imports its own CSS. It adds no dependencies or configuration.
Hover a top-level block to show the handle; drag with the primary mouse button.
Lists, tables, quotes, and their nested contents move as complete top-level nodes.
Alt+Shift+ArrowUp/ArrowDown moves the block containing the cursor. The handle also
accepts these keys; Enter/Space selects its block and returns focus to the editor.

The floating widgets live outside the document DOM and are never serialized.
Hover and drag previews do not dispatch transactions. A completed move dispatches
one transaction and participates in normal update/dirty reporting and undo.
Escape, window blur, scroll/resize, a concurrent document change, lost mouse
release, or switching to read-only cancels dragging. Read-only editors cannot move
blocks. Actual WKWebView mouse dragging still requires the planned manual check.

Pure exports:

- `moveBlock(state, fromIndex, dropIndex)` returns a transaction or `null` without
  mutating state. Both indices refer to the original document; `fromIndex` names
  a top-level child and `dropIndex` names a boundary from `0` to `childCount`.
  The boundaries immediately before/after the source are no-ops.
- `dropIndexFromY(clientY, rects)` returns a boundary using each block's vertical
  midpoint. Rectangles and Y must use the same viewport coordinate space.
