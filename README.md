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

A temporary failure to check a file reports it as unavailable. If a later
check finds the same saved version without a conflict, that temporary warning
clears. A confirmed change or conflict remains flagged until the user reloads
or saves a copy; a metadata check cannot prove the server has synchronized.

Typing may continue during an ordinary save. The saved snapshot and the live
buffer are compared on completion; newer edits remain dirty. A successful local
write first reports that it is syncing. The message changes to “Saved and synced”
only when the account mirror reports that exact version synced, and only if no
newer edit, conflict, or other warning has replaced the pending-save message.
Local desktop and emulated-phone registered-account tests delayed a metadata
check, edited while it was pending, then saved again, checked actual server
bytes and reopened the file in a fresh browser session. Physical touch is not
verified by those tests. Sync confirmation reflects the mirror's latest known
state; another device may change the file afterward.

Text accepts files up to the shared 128 MiB storage limit, with a NUL check in the
first 1,024 bytes and strict UTF-8 decoding. Acceptance is not a guarantee that
a device can open or edit a file of that size; browser memory and responsiveness
vary with the device and the file. This is a heuristic binary check,
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
line or log. It changes display only. Line numbers are shown; Python, JavaScript/TypeScript, C/C++, Arduino `.ino`, HTML, CSS, JSON, SQL and Markdown files use syntax highlighting. The Open chooser shows all account files, including extensionless files and formats such as HTML, CSS and SQL; the editor checks the selected file for supported UTF-8 text before replacing the document. Other file types remain plain text unless a supported extension is selected. Text-size controls affect the text area,
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

If a file opened directly cannot be decoded as supported text, Text keeps the
error visible and starts a new editable note. Its first save asks for a new
path; the original file and its contents are left untouched.

The window asks before closing while a save is in progress, including a clean
note being saved as a copy. A failed or cancelled save restores the previous
clean state unless the text changed. A write already sent to storage can still
finish after the window closes.

After an open or reload finishes, Text rechecks the loaded file metadata so
changes detected during the read are reported without replacing the open text.

File-status checks are ordered: an older delayed result cannot overwrite a
newer check or report a false unavailability after a successful save. Local
desktop and emulated-phone account tests cover a delayed metadata failure,
continued editing and server sync. Existing checks also cover a changed source,
saving a copy and reopening. Physical touch remains unverified.

The Save dialog keeps a folder choice tied to the dialog that requested it.
Save waits for that choice to finish. Closing and reopening the dialog ignores
late choices, and editing the path while choosing a folder preserves the edited
path instead of silently changing it.

If a restored file is temporarily unavailable, Text retains its file reference
and keeps the editor read-only. Use Reload to retry or Open to choose another
file. A confirmed missing or invalid text file instead opens a blank note; the
original file is not changed. When a browser copy is missing, Text first
checks server synchronization; if it cannot check the server it keeps the
original reference and offers Reload. Desktop and emulated-phone tests use
simulated cache misses and sync failures, and separately open, edit and sync a
roughly 3 MiB file. They do not establish performance at the 128 MiB limit or
on a physical phone.

Open and Reload serialize file commands while their confirmation or file picker
is pending. The editor remains available for typing; changes made during a
picker still require confirmation before opening the selected file. Local
registered-account desktop and emulated-phone tests cover blocked concurrent
file actions, draft preservation, server sync and reopen. Physical touch has
not been verified by these tests.

An isolated registered-account test used Files to upload an approximately 8 MiB
LF text file, edited and saved it, compared server content and reopened it in a
fresh browser session at desktop and emulated-phone sizes. Saving LF files now
skips an unnecessary whole-document newline replacement; CRLF and CR preservation
and mixed-line-ending confirmations passed separately. These checks do not test
128 MiB files, physical phones, peak memory or a guaranteed size on any device.
