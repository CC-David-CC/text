# Application module and invariants

## Integration contract

`index.mjs` exports synchronous `mount(host)` and immediately returns
`{ element, dispose }`. It retains the supplied host contract:

- `host.w`, including `launchContext`, `editor`, `title`, `ownerSub`;
- `host.ui.make(tag, className)`;
- `host.storage.mirrorFileContext()`, `signedInSubject()`, `pickFile(options)`;
- `host.signal` for lifecycle cancellation/identity checks.

The mirrored file context is still `{ valid(), path(), files }`, with
`files.read`, `write`, `sync`, `subscribe`. No invented shared editor API,
application manifest, framework, registry, new server endpoint or filesystem
has been introduced.

## Document/file invariants

Content is read from the authorized file service, not trusted launch-context
contents. Ordinary Save uses the loaded version. Save As creates a different
path with a null expected version; the actual service must reject an existing
destination. A failed open or rejected save preserves the open text and file
identity. External changes are reported, not silently loaded over a draft.
Reload confirms before discarding edits. Edits made while a picker is open
require a second confirmation before replacement.

Typing may continue during an ordinary save. The saved snapshot and the live
buffer are compared on completion; newer edits remain dirty. Successful writes
are reported as locally saved and syncing, NOT as server-confirmed completion.

The inherited read limit is 2 MiB, with a NUL check in the first 1,024 bytes and
strict UTF-8 decoding. This is a heuristic binary check, not a proof that every
accepted file is text. These existing storage rules were not redesigned.

`dispose()` is idempotent, unsubscribes, disconnects its ResizeObserver, removes
the document listener, cancels its status timer, makes its detached UI inert and
invalidates late UI updates. A write already accepted by storage is not canceled
or claimed to have been rolled back.

## Current behavior and boundaries

The textarea is the editing surface. `w.editor.text` remains its existing host
snapshot. No custom undo manager or second engine exists. Native Ctrl/Cmd+Z,
redo and clipboard operate in the text field; toolbar undo and programmatic
replace are intentionally not added before engine history is available.

Word wrapping is initially enabled; the View menu can disable it for a wide
line or log. It changes display only. Text-size controls affect the text area,
not browser zoom or saved content. Settings live in this window's editor state;
there is no new global preference persistence mechanism.

Find is literal, uses JavaScript Unicode case-insensitive matching unless Match
case is selected, and reports non-overlapping matches. It is not locale-aware
collation, full-document highlight decoration or a regular-expression UI.
Selection/caret offsets and character counts use JavaScript UTF-16 code units;
word counts are whitespace-delimited, not linguistic analysis.

Menus are accessible menu buttons, not a falsely labeled composite menubar.
Popup arrow keys, Home/End, Enter/Space and Escape are handled. Ordinary Tab
moves among triggers and exits the editor. Native IME events are not repurposed
as application shortcuts. No claim of full accessibility certification is made.

The small Save As dialog retains the existing create-copy semantics. Errors
are visible inside the dialog; focus is bounded while it is open. A broader
save/discard/cancel workflow and standardized system dialogs should be designed
with the shell, not independently invented inside every app.

The outer title bar, mobile app switching, browser/OS keyboard viewport,
window-close confirmation and application-wide file workflows remain owned by
the shell. The current shell prompts before closing a window with unsaved text.
This app does not add a window-level beforeunload handler for unrelated apps.

## Source scope

The supplied original module implements the mirrored-file API. Its original
README also mentioned other storage modes, but those implementations were not
in the source. This module does not invent replacements for unseen variants.
