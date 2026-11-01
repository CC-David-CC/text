# Application module and invariants

## Integration contract

`index.mjs` exports synchronous `mount(host)` and immediately returns
`{ element, dispose }`. It retains the supplied host contract:

- `host.w`, including `launchContext`, `editor`, `title`, `ownerSub`;
- `host.ui.make(tag, className)`;
- `host.storage.mirrorFileContext()`, `signedInSubject()`, `pickFile(options)`;
- `host.tools.loadCodeMirror()` and the shared per-view editor API;
- `host.signal` for lifecycle cancellation/identity checks.

The mirrored file context is still `{ valid(), path(), files }`, with
`files.read`, `write`, `sync`, `subscribe`. The shared CodeMirror tool exposes
a small documented per-view editor API. There is no new server endpoint or
filesystem.

## Document/file invariants

A new document asks for a path in My files on its first Save. Choose folder
opens the shared account folder picker; an existing file is not overwritten. Content is read from the authorized file
service, not trusted launch-context contents. Ordinary Save uses the loaded version. Save As creates a different
path with a null expected version; the actual service must reject an existing
destination. A failed open or rejected save preserves the open text and file
identity. External changes are reported, not silently loaded over a draft.
Reload confirms before discarding edits. Edits made while a picker is open
require a second confirmation before replacement. If an edit arrives while
either discard confirmation is open, the editor keeps the current text and
asks the user to start the open or reload action again. Only one such action
can be in progress per editor window.

Typing may continue during an ordinary save. The saved snapshot and the live
buffer are compared on completion; newer edits remain dirty. Successful writes
are reported as locally saved and syncing, NOT as server-confirmed completion.

Text files up to the shared 128 MiB limit can be opened, with a NUL check in the
first 1,024 bytes and strict UTF-8 decoding. This is a heuristic binary check,
not a proof that every accepted file is text. Very large files need substantial
browser memory and may be slow, especially on phones or with long lines. Word
counts are omitted above 2,097,152 UTF-16 code units to avoid rescanning on every edit.

`dispose()` is idempotent, destroys the CodeMirror view, unsubscribes, disconnects its ResizeObserver, removes
the document listener, cancels its status timer, makes its detached UI inert and
invalidates late UI updates. A write already accepted by storage is not canceled
or claimed to have been rolled back.

## Current behavior and boundaries

A per-window CodeMirror 6 view is the editing surface and owns document state,
selection and undo history. The shared tool is loaded lazily. `w.editor.text`
is a host snapshot at file and disposal boundaries; there is no second editable
surface. Undo/redo, literal replace and selection indentation use CodeMirror
transactions. Clipboard and IME use the browser and editor normally.

Word wrapping is initially enabled; the View menu can disable it for a wide
line or log. It changes display only. Line numbers are shown; Python, JavaScript/TypeScript, C/C++ and Arduino `.ino` files use syntax highlighting. The Open chooser includes C/C++ source and headers and `.ino` sketches; Files can also open them directly. Text-size controls affect the text area,
not browser zoom or saved content. Settings live in this window's editor state;
there is no new global preference persistence mechanism.

Find is literal, uses JavaScript Unicode case-insensitive matching unless Match
case is selected, and reports non-overlapping matches. Search stores at most 50,000 matches; if
there are more, Find next, Find previous and Replace still navigate the full
document. Replace all is disabled until the search is narrowed so it cannot
silently replace only part of the document. It is not locale-aware
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

When a locally saved revision still has a server conflict, Text reports that it needs resolution in Files instead of claiming it is syncing. A conflict that arrives while a save is finishing is checked again after the operation.

Text loads the shared CodeMirror tool through the desktop host. Install its
pinned packages with `npm ci --prefix apps/system/codemirror --ignore-scripts`.
The standard app builder automatically includes the `codemirror` bundle when
Text is selected, including `--apps text` builds. Custom source/entry overlays
must include their own required host-loaded tools. JupyterLite supplies its own
independent CodeMirror integration.

Files with consistently LF, CRLF, or CR line endings retain that style when
saved, including when saved as a copy. A UTF-8 byte-order mark is preserved. Files with mixed line endings show a
warning, and saving or saving a copy asks before normalizing them to LF.
Cancel to keep the open text and original file unchanged.
