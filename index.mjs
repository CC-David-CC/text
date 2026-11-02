import {createTextLifecycle} from './lifecycle.mjs';
/** CodiServer Text v0.2.0 — compact UI, unchanged mount(host) file contract.
 * Desktop: File / Edit / View | Reload / Find | document name / Save.
 * Phone: the approved document header + Open / Save / Find bottom bar.
 * These are presentations of ONE command table and ONE editing surface.
 *
 * The shared CodeMirror tool supplies independent per-window editor state.
 */
let nextInstanceId = 0;

export function mount(host) {
  const instanceId = `ce-editor-${++nextInstanceId}`;
  const { w } = host;
  const { make } = host.ui;
  const { mirrorFileContext, signedInSubject } = host.storage;
  const launch = w.launchContext;
  const owner = launch?.owner || signedInSubject();
  const state = w.editor ??= {
    storage: 'mirror', path: launch?.path || '/Untitled.txt', text: '',
    version: null, loaded: !launch, dirty: false, changed: false, wrap: true
  };
  state.wrap ??= true; // New documents wrap; an explicit user toggle is respected.
  state.lineEnding ??= '\n';
  state.mixedLineEndings ??= false;
  state.hasUTF8BOM ??= false;
  state.textSize ??= 0; // Relative steps: the phone keeps its larger base size.
  if (owner) w.ownerSub = owner;

  const body = make('div', 'window-content codi-text-editor');
  const style = document.createElement('style');
  style.textContent = STYLES;
  body.append(style);

  const el = (tag, cls, content) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (content != null) node.textContent = content;
    return node;
  };
  const btn = (cls, label, title) => {
    const node = el('button', cls);
    node.type = 'button';
    node.setAttribute('aria-label', label);
    if (title) node.title = title;
    return node;
  };
  const icon = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const path of ICONS[name] || []) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', path);
      svg.append(p);
    }
    return svg;
  };
  const fileName = () => state.path.split('/').filter(Boolean).pop() || 'Untitled.txt';
  let disposed = false, quiesced = false, priorInert = false;
  const valid = () => !disposed && !quiesced && !host.signal.aborted && body.isConnected && signedInSubject() === owner;
  let busy = false, writePending = false, replacing = false, revision = 0, editRevision = 0, commandRevision = 0, fileCheckRevision = 0, unsubscribe = () => {}, infoTimer = null;
  let saveDialogEpoch = 0, folderChoice = null;
  // A failed metadata check is not evidence that the saved file changed.
  // Remember whether that failure alone raised the warning so a later
  // successful check can clear it without hiding a real conflict or change.
  let unavailableWithoutChange = false;
  let notice = '', noticeKind = '', activeMenu = null, menuTrigger = null;

  // Main window contents. The title bar itself continues to be owned by CodiServer.
  const header = el('div', 'ce-header');
  const menuSet = el('div', 'ce-menu-set');
  const docName = el('div', 'ce-docname');
  docName.append(icon('document'));
  const nameText = el('span', 'ce-name');
  const dirtyDot = el('span', 'ce-dirty-dot');
  dirtyDot.title = 'Unsaved changes';
  docName.append(nameText, dirtyDot);
  const overflow = btn('ce-mobile-menu ce-menu-trigger', 'More commands', 'More commands');
  overflow.append(icon('more'));
  overflow.dataset.menu = 'All';
  header.append(menuSet, docName, overflow);

  // A compact desktop command row; the phone-only toolbar below is a different
  // presentation, not a different command implementation or document state.
  const quickActions = el('div', 'ce-quick-actions');
  header.insertBefore(quickActions, docName);
  const desktopSave = el('div', 'ce-desktop-save');
  header.insertBefore(desktopSave, overflow);
  const toolbar = el('div', 'ce-toolbar');
  toolbar.setAttribute('aria-label', 'Document actions');

  // The per-window CodeMirror view is the editing authority.
  const area = el('div', 'ce-editor');
  let editor = null;
  const value = () => editor ? editor.getText() : state.text;
  const selection = () => editor ? editor.getSelection() : {from:0,to:0,head:0};
  const focusEditor = () => editor?.focus();
  body.style.setProperty('--ce-text-step', state.textSize + 'px');

  const findBar = el('form', 'ce-findbar');
  findBar.hidden = true;
  const findLabel = el('label', 'ce-sr-only', 'Find in document');
  findLabel.htmlFor = instanceId + '-find';
  const findInput = el('input', 'ce-find-input');
  findInput.id = findLabel.htmlFor;
  findInput.type = 'search';
  findInput.placeholder = 'Find in document';
  findInput.autocomplete = 'off';
  findInput.spellcheck = false;
  findInput.setAttribute('aria-label', 'Find in document');
  const findCount = el('span', 'ce-find-count', '');
  findCount.setAttribute('role', 'status');
  const matchCase = btn('ce-iconbutton ce-match-case', 'Match case', 'Match case');
  matchCase.textContent = 'Aa'; matchCase.setAttribute('aria-pressed', 'false');
  const findPrev = btn('ce-iconbutton', 'Previous result'); findPrev.append(icon('up'));
  const findNext = btn('ce-iconbutton', 'Next result'); findNext.append(icon('down'));
  const findClose = btn('ce-iconbutton', 'Close search'); findClose.append(icon('close'));
  findBar.append(findLabel, findInput, matchCase, findCount, findPrev, findNext, findClose);
  const replaceBar = el('form', 'ce-replacebar'); replaceBar.hidden = true;
  const replaceInput = el('input', 'ce-find-input'); replaceInput.type = 'text'; replaceInput.placeholder = 'Replace with'; replaceInput.setAttribute('aria-label', 'Replace with');
  const replaceOne = el('button', 'ce-tool', 'Replace'); replaceOne.type = 'submit';
  const replaceAllButton = btn('ce-tool', 'Replace all'); replaceAllButton.textContent = 'Replace all';
  replaceBar.append(replaceInput, replaceOne, replaceAllButton);


  // Navigation is temporary UI, not another permanent toolbar.
  const lineBar = el('form', 'ce-linebar'); lineBar.hidden = true;
  const lineLabel = el('label', '', 'Go to line');
  const lineInput = el('input', 'ce-line-input');
  lineInput.type = 'number'; lineInput.min = '1'; lineInput.step = '1';
  lineInput.inputMode = 'numeric'; lineInput.required = true;
  lineInput.setAttribute('aria-label', 'Line number'); lineLabel.append(lineInput);
  const lineGo = el('button', 'ce-tool', 'Go'); lineGo.type = 'submit';
  const lineHint = el('span', 'ce-line-hint');
  const lineClose = btn('ce-iconbutton', 'Close line navigation'); lineClose.append(icon('close'));
  lineBar.append(lineLabel, lineGo, lineHint, lineClose);

  const status = el('div', 'ce-status');
  const statusMessage = el('span', 'ce-status-message', 'Ready');
  statusMessage.setAttribute('role', 'status');
  statusMessage.setAttribute('aria-live', 'polite');
  const metrics = el('div', 'ce-metrics');
  const position = el('span', 'ce-position');
  const words = el('span', 'ce-words');
  const encoding = el('span', 'ce-encoding', 'UTF-8');
  metrics.append(position, words, encoding);
  status.append(statusMessage, metrics);

  // Save As is explicitly distinct from Save. The former uses null expected
  // version to create a destination; the server must reject existing files.
  const backdrop = el('div', 'ce-dialog-backdrop'); backdrop.hidden = true;
  const lifecycle = createTextLifecycle({
    readState: () => ({dirty:!!state.dirty,pending:busy||replacing||!!folderChoice||!backdrop.hidden||!editor||!state.loaded,quiesced}),
    pause: () => {priorInert=body.inert;quiesced=true;body.inert=true;try{editor?.setReadOnly(true);}catch(error){quiesced=false;body.inert=priorInert;throw error;}},
    resume: () => {quiesced=false;body.inert=priorInert;editor?.setReadOnly(!state.loaded||!owner);}
  });
  const dialog = el('form', 'ce-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', instanceId + '-save-title');
  const dialogTitle = el('h2', '', 'Save a copy'); dialogTitle.id = instanceId + '-save-title';
  const pathLabel = el('label', '', 'Path in My files');
  const pathInput = el('input', 'ce-path-input'); pathInput.type = 'text';
  pathInput.setAttribute('aria-label', 'Destination path');
  pathInput.autocomplete = 'off'; pathLabel.append(pathInput);
  const browseFolder = btn('ce-browse-folder', 'Choose folder in My files');
  browseFolder.textContent = 'Choose folder…';
  browseFolder.hidden = typeof host.storage.pickFolder !== 'function';
  const dialogError = el('div', 'ce-dialog-error');
  dialogError.setAttribute('role', 'alert'); dialogError.hidden = true;
  const dialogActions = el('div', 'ce-dialog-actions');
  const cancelSaveAs = btn('ce-dialog-cancel', 'Cancel', 'Cancel'); cancelSaveAs.textContent = 'Cancel';
  const confirmSaveAs = el('button', 'ce-dialog-primary', 'Save copy'); confirmSaveAs.type = 'submit';
  dialogActions.append(cancelSaveAs, confirmSaveAs);
  dialog.append(dialogTitle, pathLabel, browseFolder, dialogError, dialogActions); backdrop.append(dialog);

  // One command table serves menu, touch controls and keyboard shortcuts.
  // Editing commands operate on this window’s CodeMirror view.
  const isApple = /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcut = text => text.replaceAll('Ctrl', isApple ? 'Cmd' : 'Ctrl');
  const commands = {
    open: { label: 'Open…', ico: 'folder', key: 'Ctrl+O', file: true, run: openFile },
    save: { label: 'Save', ico: 'save', key: 'Ctrl+S', file: true, run: () => save() },
    saveAs: { label: 'Save As…', ico: 'copy', key: 'Ctrl+Shift+S', file: true, run: showSaveAs },
    reload: { label: 'Reload from disk', ico: 'refresh', key: '', file: true, run: reload },
    undo: { label: 'Undo', ico: 'undo', key: 'Ctrl+Z', run: () => editor?.undo() },
    redo: { label: 'Redo', ico: 'redo', key: 'Ctrl+Shift+Z', run: () => editor?.redo() },
    find: { label: 'Find…', ico: 'search', key: 'Ctrl+F', run: openFind },
    replace: { label: 'Replace…', ico: 'replace', key: '', run: openReplace },
    indent: { label: 'Indent selection', ico: 'indent', key: '', run: () => editor?.indent() },
    outdent: { label: 'Outdent selection', ico: 'outdent', key: '', run: () => editor?.outdent() },
    findNext: { label: 'Find next', ico: 'down', key: 'F3', run: () => findInput.value ? findDirection(1) : openFind() },
    findPrev: { label: 'Find previous', ico: 'up', key: 'Shift+F3', run: () => findInput.value ? findDirection(-1) : openFind() },
    goLine: { label: 'Go to line…', ico: 'lines', key: '', run: openGoLine },
    selectAll: { label: 'Select all', ico: 'select', key: 'Ctrl+A', run: () => { editor?.selectAll(); } },
    wrap: { label: 'Word wrap', ico: 'wrap', key: '', run: toggleWrap },
    textLarger: { label: 'Increase text size', ico: 'plus', key: '', run: () => changeTextSize(1) },
    textSmaller: { label: 'Decrease text size', ico: 'minus', key: '', run: () => changeTextSize(-1) },
    textReset: { label: 'Reset text size', ico: 'text', key: '', run: () => changeTextSize(0) }
  };
  const groups = [
    ['File', ['open', 'save', 'saveAs', 'reload']],
    ['Edit', ['undo', 'redo', 'find', 'replace', 'findNext', 'findPrev', 'goLine', 'selectAll', 'indent', 'outdent']],
    ['View', ['wrap', 'textLarger', 'textSmaller', 'textReset']]
  ];
  function commandEnabled(id) {
    const cmd = commands[id];
    return !!cmd && !disposed && !quiesced && !host.signal.aborted && !busy
      && !!editor && (state.loaded || id === 'open' || (id === 'reload' && !!w.launchContext?.path))
      && (!cmd.file || (!!owner && !replacing))
      && !(id === 'reload' && state.version == null && (state.loaded || !w.launchContext?.path))
      && !(id === 'textLarger' && state.textSize >= 8)
      && !(id === 'textSmaller' && state.textSize <= -2);
  }
  const menuButtons = [];
  function commandItem(id) {
    const cmd = commands[id];
    const item = btn('ce-command', cmd.label);
    item.dataset.command = id; item.tabIndex = -1;
    item.setAttribute('role', id === 'wrap' ? 'menuitemcheckbox' : 'menuitem');
    item.append(icon(cmd.ico), el('span', 'ce-command-label', cmd.label));
    if (cmd.key) item.append(el('span', 'ce-shortcut', shortcut(cmd.key)));
    if (id === 'wrap') item.setAttribute('aria-checked', String(state.wrap));
    return item;
  }
  // These are menu BUTTONS, not an ARIA menubar with incomplete keyboard rules.
  // Normal Tab reaches each trigger; each popup implements menu navigation.
  for (const [group] of groups) {
    const trigger = btn('ce-menu-trigger', group);
    trigger.dataset.menu = group; trigger.textContent = group;
    menuButtons.push(trigger); menuSet.append(trigger);
  }
  menuButtons.push(overflow);
  const popup = el('div', 'ce-popup'); popup.hidden = true;
  popup.id = instanceId + '-menu'; popup.setAttribute('role', 'menu');
  popup.setAttribute('aria-label', 'Application commands');
  for (const trigger of menuButtons) {
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', popup.id);
  }
  header.append(popup);
  function tool(id, parent) {
    const cmd = commands[id];
    const node = btn('ce-tool', cmd.label, cmd.label + (cmd.key ? ' (' + shortcut(cmd.key) + ')' : ''));
    node.dataset.command = id;
    node.append(icon(cmd.ico), el('span', 'ce-tool-label', cmd.label));
    if (id === 'save') node.classList.add('ce-save-tool');
    parent.append(node);
  }
  tool('reload', quickActions); tool('find', quickActions);
  tool('save', desktopSave);
  // Preserve the approved phone arrangement. Open is menu-only on desktop.
  for (const id of ['open', 'save', 'find']) tool(id, toolbar);
  body.append(header, toolbar, findBar, replaceBar, lineBar, area, status, backdrop);

  function updateTitle() {
    nameText.textContent = fileName();
    docName.title = state.path;
    dirtyDot.hidden = !state.dirty;
    w.title = fileName() + (state.dirty ? ' *' : '') + ' — Text Editor';
    const caption = body.closest('.window')?.querySelector('.window-caption .caption-text');
    if (caption && caption.textContent !== w.title) caption.textContent = w.title;
  }
  function setNotice(message, kind = '') { if (disposed) return; notice = message; noticeKind = kind; updateStatus(); }
  function updateStatus() {
    if (disposed) return;
    const defaultMessage = state.changed
      ? 'File changed outside editor — reload or resolve in Files.'
      : state.mixedLineEndings ? 'Mixed line endings will be converted to LF when saved.'
      : state.dirty ? 'Unsaved changes' : busy ? 'Working…' : 'Ready';
    statusMessage.textContent = notice || defaultMessage;
    statusMessage.title = statusMessage.textContent;
    statusMessage.dataset.kind = noticeKind || (state.changed || state.mixedLineEndings ? 'warning' : '');
    updateTitle();
    for (const button of body.querySelectorAll('[data-command]')) {
      const id = button.dataset.command;
      const enabled = commandEnabled(id);
      // Disabled menu items remain focusable by arrow keys, but cannot execute.
      if (button.getAttribute('role')?.startsWith('menuitem')) button.setAttribute('aria-disabled', String(!enabled));
      else button.disabled = !enabled;
      if (id === 'wrap') button.setAttribute('aria-checked', String(state.wrap));
    }
    confirmSaveAs.disabled = cancelSaveAs.disabled = pathInput.disabled = browseFolder.disabled = busy;
    scheduleInfo();
  }
  function scheduleInfo() {
    clearTimeout(infoTimer);
    infoTimer = setTimeout(() => {
      if (disposed || host.signal.aborted) return;
      if (!editor) return;
      const info = editor.getInfo();
      position.textContent = `Ln ${info.line}, Col ${info.column}`;
      if (info.length > 2 * 1024 * 1024) { words.textContent = `${info.length} chars`; return; }
      const text = value(); let count = 0, inWord = false;
      for (let i = 0; i < text.length; i++) {
        const isSpace = /\s/.test(text[i]);
        if (!isSpace && !inWord) count++;
        inWord = !isSpace;
      }
      words.textContent = `${count} words · ${info.length} chars`;
    }, 100);
  }

  function closeMenu(restoreFocus = false) {
    const previous = menuTrigger;
    activeMenu = null;
    previous?.setAttribute('aria-expanded', 'false');
    menuTrigger = null; popup.hidden = true;
    if (restoreFocus && previous?.isConnected) previous.focus();
  }
  function toggleMenu(group, trigger) {
    if (activeMenu === group) { closeMenu(true); return; }
    closeMenu();
    activeMenu = group; menuTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    popup.setAttribute('aria-label', group === 'All' ? 'Application commands' : group);
    popup.replaceChildren();
    for (const [label, ids] of groups) {
      if (group !== 'All' && group !== label) continue;
      if (group === 'All') {
        const heading = el('div', 'ce-popup-heading', label);
        heading.setAttribute('role', 'presentation'); popup.append(heading);
      }
      for (const id of ids) popup.append(commandItem(id));
    }
    popup.hidden = false;
    // Popups belong to this app window, not the whole browser viewport. A short
    // window or keyboard-reduced phone must still be able to reach every item.
    popup.style.maxHeight = Math.max(0, Math.min(460, body.clientHeight - header.offsetHeight - 8)) + 'px';
    const t = trigger.getBoundingClientRect(), h = header.getBoundingClientRect();
    const left = Math.max(0, Math.min(t.left - h.left, h.width - popup.offsetWidth - 4));
    popup.style.left = group === 'All' ? 'auto' : left + 'px';
    popup.style.right = group === 'All' ? '8px' : 'auto';
    updateStatus(); popup.querySelector('[data-command]')?.focus();
  }
  function execute(id) {
    if (!commandEnabled(id) || !valid()) return;
    commands[id].run();
  }
  header.addEventListener('click', event => {
    const trigger = event.target.closest('[data-menu]');
    if (trigger) { event.preventDefault(); toggleMenu(trigger.dataset.menu, trigger); }
  });
  header.addEventListener('keydown', event => {
    const trigger = event.target.closest('[data-menu]');
    if (!trigger || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    if (activeMenu !== trigger.dataset.menu) toggleMenu(trigger.dataset.menu, trigger);
    const items = popup.querySelectorAll('[data-command]');
    (event.key === 'ArrowUp' ? items[items.length - 1] : items[0])?.focus();
  });
  popup.addEventListener('keydown', event => {
    const items = [...popup.querySelectorAll('[data-command]')];
    const i = items.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (i + 1) % items.length;
    if (event.key === 'ArrowUp') next = (i + items.length - 1) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (next != null) { event.preventDefault(); items[next]?.focus(); }
    if (event.key === 'Tab') {
      // Restore the trigger before the browser performs its ordinary Tab move.
      closeMenu(true);
    }
  });
  body.addEventListener('click', event => {
    const button = event.target.closest('[data-command]');
    if (!button || !commandEnabled(button.dataset.command)) return;
    event.preventDefault();
    const id = button.dataset.command;
    if (activeMenu) closeMenu(true);
    execute(id);
  });
  function outsideMenu(event) {
    if (activeMenu && !popup.contains(event.target) && !menuTrigger?.contains(event.target)) closeMenu();
  }
  document.addEventListener('pointerdown', outsideMenu, true);
  // Never rebuild/remount an editor just because its window changes size.
  // Only close a now-misplaced popup when container geometry changes.
  const layoutObserver = new ResizeObserver(() => {
    if (activeMenu) {
      const hadFocus = popup.contains(document.activeElement);
      closeMenu(); if (hadFocus) focusEditor();
    }
  });
  layoutObserver.observe(body);

  async function load({ target = state.path, checkServer = false } = {}) {
    if (busy || !valid()) return;
    busy = true; fileCheckRevision++; editor?.setReadOnly(true); setNotice('Opening file…'); lifecycle.changed();
    const token = ++revision; let loadContext = null, broken = false;
    try {
      const c = await mirrorFileContext();
      if (!valid()) return;
      if (!c.valid()) throw Error('File storage is unavailable.');
      loadContext = c;
      let offline = false, synced = false;
      if (checkServer) try { await c.files.sync(); synced = true; } catch { offline = true; }
      let r;
      try { r = await c.files.read(target); }
      catch (error) {
        if (error?.message !== 'File not found.' || !c.valid()) throw error;
        // A missing browser copy is not proof that the server copy is gone.
        // Only clear the restore path after a successful server sync.
        if (!synced && !offline) try { await c.files.sync(); synced = true; } catch { offline = true; }
        if (offline) throw Error('The file is not available on this device and the server could not be checked.');
        if (!valid() || !c.valid() || token !== revision) return;
        try { r = await c.files.read(target); }
        catch (retryError) { if (retryError?.message === 'File not found.' && c.valid()) broken = true; throw retryError; }
      }
      if (!valid() || token !== revision) return;
      if (!c.valid()) throw Error('File storage is unavailable.');
      let text;
      try {
        if (r.data.length > 128 * 1024 * 1024) throw Error('Text files are limited to 128 MiB.');
        if (r.data.subarray(0, 1024).includes(0)) throw Error('This file cannot be opened as text.');
        text = new TextDecoder('utf-8', { fatal: true }).decode(r.data);
      } catch (error) { broken = c.valid(); throw error; }
      // Create the replacement before switching the saved file identity; if a
      // device cannot allocate it, the previous editor and path remain open.
      const endings = /\r\n|\r|\n/g; let firstEnding = null, mixed = false, ending;
      while ((ending = endings.exec(text))) { if (firstEnding === null) firstEnding = ending[0]; else if (firstEnding !== ending[0]) { mixed = true; break; } }
      editor.replaceDocument(text, target); commandRevision++;
      state.lineEnding = mixed ? '\n' : firstEnding || '\n'; state.mixedLineEndings = mixed;
      state.hasUTF8BOM = r.data.length >= 3 && r.data[0] === 0xef && r.data[1] === 0xbb && r.data[2] === 0xbf;
      state.path = target; state.text = text; state.version = r.version;
      state.loaded = true; state.dirty = false; state.changed = r.status === 'conflict'; unavailableWithoutChange = false;
      updateFindCount(); lineBar.hidden = true;
      setNotice(r.status === 'conflict' ? 'Conflicting file copies — resolve in Files.'
        : offline ? 'Loaded browser copy; server could not be reached.' : '',
        r.status === 'conflict' ? 'warning' : '');
    } catch (error) {
      if (valid()) {
        if (!state.loaded && broken && loadContext?.valid()) {
          editor.replaceDocument('', '/Untitled.txt'); commandRevision++;
          state.path = '/Untitled.txt'; state.text = ''; state.version = null;
          state.loaded = true; state.dirty = false; state.changed = false;
          state.lineEnding = '\n'; state.mixedLineEndings = false; state.hasUTF8BOM = false;
          w.launchContext = null;
          setNotice(error.message + ' A new blank note is ready.', 'error');
        } else if (!state.loaded) setNotice(error.message + ' Use Reload to try again, or open another file.', 'error');
        else setNotice(error.message, 'error');
      }
    } finally {
      busy = false; lifecycle.changed();
      if (valid()) editor?.setReadOnly(!state.loaded);
      if (!disposed) updateStatus();
      if (valid() && loadContext?.valid()) void observe(loadContext);
    }
  }
  async function observe(c) {
    if (!valid() || busy || !state.loaded || !state.version) return;
    const observedPath = state.path, observedVersion = state.version, check = ++fileCheckRevision;
    try {
      const r = await (typeof c.files.stat === 'function' ? c.files.stat(observedPath) : c.files.read(observedPath));
      if (!valid() || !c.valid() || busy || check !== fileCheckRevision || state.path !== observedPath || state.version !== observedVersion) return;
      if (r.status === 'conflict') {
        unavailableWithoutChange = false; state.changed = true;
        setNotice(state.dirty ? 'Conflicting file copies — resolve in Files. Newer edits are unsaved.' : 'Conflicting file copies — resolve in Files.', 'warning');
      } else if (r.version !== observedVersion) {
        unavailableWithoutChange = false; state.changed = true;
        setNotice('', '');
      } else if (unavailableWithoutChange) {
        unavailableWithoutChange = false; state.changed = false;
        if (notice === 'Saved file unavailable. Your open text is unchanged.') setNotice('', '');
        else updateStatus();
      }
      // A successful local write is not yet a server save. Only promote the
      // status when the mirror reports this exact version synced and no later
      // edit or warning has replaced the pending-save message.
      if (r.status === 'synced' && !state.changed && !state.dirty && notice === 'Saved locally; syncing with server…') setNotice('Saved and synced.', '');
    } catch {
      if (valid() && c.valid() && !busy && check === fileCheckRevision && state.path === observedPath && state.version === observedVersion) {
        if (!state.changed) unavailableWithoutChange = true;
        state.changed = true;
        setNotice('Saved file unavailable. Your open text is unchanged.', 'warning');
      }
    }
  }
  queueMicrotask(async () => {
    try {
      const c = await mirrorFileContext();
      if (!valid() || !c.valid()) return;
      unsubscribe = c.files.subscribe(() => observe(c));
      await observe(c);
    } catch (error) { if (valid()) setNotice(error.message, 'error'); }
  });

  async function save(target = state.path, asCopy = false, command = false) {
    if (busy || replacing || !valid()) return;
    if (!state.loaded) { setNotice('Load the file before saving.', 'warning'); return; }
    if (!asCopy && state.version === null) { showSaveAs(); return; }
    busy = true; fileCheckRevision++; writePending = true; state.dirty = true; lifecycle.changed(); let savedContext = null;
    updateStatus();
    try {
      if (state.mixedLineEndings) {
        const before = editRevision;
        const accepted = await host.ui.confirm('This file has mixed line endings. Saving will convert them to LF. Continue?', {title:'Mixed line endings',confirmLabel:'Save with LF',cancelLabel:'Keep editing',signal:host.signal});
        if (!accepted || !valid()) return;
        if (editRevision !== before) { setNotice('Text changed while confirming. Nothing was saved.', 'warning'); return; }
      }
      const snapshotDoc = editor.snapshot(), text = snapshotDoc.toString(), snapshot = (state.hasUTF8BOM ? '\ufeff' : '') + (state.lineEnding === '\n' ? text : text.replace(/\n/g, state.lineEnding));
      setNotice('Saving…');
      const c = await mirrorFileContext();
      if (!valid() || !c.valid()) { if (command) throw Error('The document session ended before saving.'); return; }
      const normalized = c.path(target);
      if (asCopy && state.version !== null && normalized === c.path(state.path)) throw Error('Choose a different path for Save As.');
      const r = await c.files.write(normalized, snapshot, asCopy ? null : state.version);
      if (!valid()) return;
      if (state.path !== normalized) commandRevision++;
      state.path = normalized; state.version = r.version; state.mixedLineEndings = false; editor.setPath?.(normalized);
      state.changed = r.status === 'conflict'; unavailableWithoutChange = false; state.text = value();
      editor.markSaved(snapshotDoc); state.dirty = !editor.isClean();
      hideSaveAs();
      savedContext = c;
      setNotice(state.changed ? (state.dirty ? 'Saved on this device; newer edits are unsaved. Resolve conflicting copies in Files.' : 'Saved on this device; conflicting copies need resolution in Files.')
        : state.dirty ? 'Earlier revision saved; newer edits remain unsaved.'
        : 'Saved locally; syncing with server…', state.changed ? 'warning' : '');
      return {path:normalized, status:r.status, dirty:state.dirty, revision:commandRevision};
    } catch (error) {
      if (valid()) {
        setNotice(error.message, 'error');
        if (!backdrop.hidden) { dialogError.textContent = error.message; dialogError.hidden = false; }
      }
      if (command) throw error;
    } finally { writePending = false; busy = false; if (!disposed && editor) { state.dirty = !editor.isClean(); updateStatus(); } lifecycle.changed(); if (savedContext && valid() && savedContext.valid()) void observe(savedContext); }
  }
  async function confirmDiscard(message) {
    const before = editRevision;
    const accepted = await host.ui.confirm(message, {title:'Unsaved changes',confirmLabel:'Discard changes',cancelLabel:'Keep editing',danger:true,signal:host.signal});
    if (!accepted || !valid()) return false;
    if (editRevision !== before) { setNotice('Text changed while confirming. Nothing was discarded.', 'warning'); return false; }
    return true;
  }
  async function openFile() {
    if (busy || replacing || !valid()) return;
    replacing = true; lifecycle.changed(); updateStatus();
    try {
      if (state.dirty && !await confirmDiscard('Discard unsaved changes and open another file?')) return;
      if (!valid()) return;
      const beforePicker = editRevision;
      const selected = await host.storage.pickFile({
        signal: host.signal
      });
      if (!selected || !valid()) return;
      // A picker can remain open while the user keeps typing. Do not discard
      // edits made *after* the first confirmation without asking again.
      if (editRevision !== beforePicker && !await confirmDiscard('Discard edits made while the file picker was open?')) return;
      if (!valid()) return;
      await load({ target: selected });
    } catch (error) { if (valid()) setNotice(error.message, 'error'); }
    finally { replacing = false; lifecycle.changed(); if (valid()) updateStatus(); }
  }
  async function reload() {
    if (busy || replacing || !valid()) return;
    replacing = true; lifecycle.changed(); updateStatus();
    try {
      if (state.dirty && !await confirmDiscard('Discard unsaved changes and reload?')) return;
      if (valid()) await load({ checkServer: true });
    } finally { replacing = false; lifecycle.changed(); if (valid()) updateStatus(); }
  }
  function showSaveAs() {
    if (busy || replacing || !valid()) return;
    closeMenu();
    saveDialogEpoch++;
    const firstSave = state.version === null;
    dialogTitle.textContent = firstSave ? 'Save to My files' : 'Save a copy';
    confirmSaveAs.textContent = firstSave ? 'Save' : 'Save copy';
    pathInput.value = state.path;
    dialogError.hidden = true;
    backdrop.hidden = false; lifecycle.changed();
    pathInput.focus(); pathInput.select();
  }
  function hideSaveAs() {
    const wasOpen = !backdrop.hidden; backdrop.hidden = true;
    if (wasOpen) { saveDialogEpoch++; folderChoice = null; browseFolder.disabled = busy; lifecycle.changed(); }
    if (wasOpen && !disposed) focusEditor();
  }
  browseFolder.addEventListener('click', async () => {
    if (busy || folderChoice || !valid() || backdrop.hidden || typeof host.storage.pickFolder !== 'function') return;
    const choice = { epoch: saveDialogEpoch, path: pathInput.value };
    folderChoice = choice; lifecycle.changed();
    browseFolder.disabled = true;
    try {
      const folder = await host.storage.pickFolder({signal: host.signal});
      if (folder === null || !valid() || backdrop.hidden || choice.epoch !== saveDialogEpoch) return;
      const c = await mirrorFileContext();
      if (!valid() || !c.valid() || backdrop.hidden || choice.epoch !== saveDialogEpoch) return;
      if (pathInput.value !== choice.path) { dialogError.textContent = 'The file path changed while choosing a folder. Choose again.'; dialogError.hidden = false; return; }
      const name = pathInput.value.trim().split('/').filter(Boolean).pop() || fileName();
      pathInput.value = c.path((folder === '/' ? '' : folder) + '/' + c.name(name));
      dialogError.hidden = true;
      pathInput.focus();
    } catch (error) {
      if (valid() && !backdrop.hidden && choice.epoch === saveDialogEpoch) { dialogError.textContent = error.message; dialogError.hidden = false; }
    } finally { if (folderChoice === choice) { folderChoice = null; lifecycle.changed(); if (valid()) browseFolder.disabled = busy; } }
  });
  cancelSaveAs.addEventListener('click', () => { if (!busy) hideSaveAs(); });
  backdrop.addEventListener('click', event => { if (event.target === backdrop && !busy) hideSaveAs(); });
  dialog.addEventListener('submit', event => {
    event.preventDefault();
    if (folderChoice) { dialogError.textContent = 'Finish choosing a folder before saving.'; dialogError.hidden = false; return; }
    if (pathInput.value.trim()) save(pathInput.value, true);
  });
  function toggleWrap() {
    state.wrap = !state.wrap;
    editor?.setWrap(state.wrap);
    updateStatus();
  }
  function changeTextSize(step) {
    state.textSize = step === 0 ? 0 : Math.max(-2, Math.min(8, state.textSize + step));
    body.style.setProperty('--ce-text-step', state.textSize + 'px');
    updateStatus();
  }
  function openGoLine() {
    findBar.hidden = true; replaceBar.hidden = true; lineBar.hidden = false;
    const info = editor.getInfo(), count = info.lines;
    lineInput.max = String(count);
    lineInput.value = String(info.line);
    lineHint.textContent = `of ${count}`;
    lineInput.focus(); lineInput.select();
  }
  lineBar.addEventListener('submit', event => {
    event.preventDefault();
    const target = Number(lineInput.value), count = editor.getInfo().lines;
    if (!Number.isInteger(target) || target < 1 || target > count) return;
    const offset = editor.lineOffset(target);
    revealSelection(offset, offset);
    lineBar.hidden = true; scheduleInfo();
  });
  lineClose.addEventListener('click', () => { lineBar.hidden = true; focusEditor(); });

  // The application keeps one literal-search interface.
  let matches = [], currentMatch = -1;
  function openFind() {
    lineBar.hidden = true; findBar.hidden = false;
    const range = selection(), selected = range.to - range.from <= 120 ? editor.selectedText() : '';
    if (selected && !selected.includes('\n')) findInput.value = selected;
    updateFindCount(); findInput.focus(); findInput.select();
  }
  function openReplace() { openFind(); replaceBar.hidden = false; }
  function closeFind() { findBar.hidden = true; replaceBar.hidden = true; focusEditor(); }
  function renderFindCount() {
    replaceAllButton.disabled = !!matches.truncated;
    if (matches.truncated) { findCount.textContent = '50,000+ matches; narrow your search.'; findPrev.disabled = findNext.disabled = false; return; }
    findCount.textContent = !findInput.value ? '' : matches.length
      ? (currentMatch >= 0 ? `${currentMatch + 1} / ${matches.length}` : `${matches.length} found`)
      : 'No results';
    findPrev.disabled = findNext.disabled = !matches.length;
  }
  function updateFindCount() {
    matches = []; currentMatch = -1;
    if (findInput.value) {
      matches = editor?.findAll(findInput.value, matchCase.getAttribute('aria-pressed') === 'true') || [];
    }
    renderFindCount();
  }
  function revealSelection(start, end) {
    editor?.select(start, end); focusEditor();
  }
  function findDirection(direction) {
    if (!findInput.value) return;
    updateFindCount();
    if (!matches.length) return;
    if (matches.truncated) {
      const selected = selection(), range = editor.findFrom(findInput.value, matchCase.getAttribute('aria-pressed') === 'true', direction > 0 ? selected.to : selected.from, direction);
      if (range) { revealSelection(range[0], range[1]); scheduleInfo(); }
      return;
    }
    if (direction > 0) {
      currentMatch = matches.findIndex(([start]) => start >= selection().to);
      if (currentMatch < 0) currentMatch = 0;
    } else {
      currentMatch = matches.findLastIndex(([start]) => start < selection().from);
      if (currentMatch < 0) currentMatch = matches.length - 1;
    }
    const [start, end] = matches[currentMatch];
    revealSelection(start, end);
    scheduleInfo(); renderFindCount();
  }
  function replaceNext() {
    updateFindCount(); if (!matches.length) return;
    const selected = selection(); let range;
    if (matches.truncated) range = editor.selectionMatches(findInput.value, matchCase.getAttribute('aria-pressed') === 'true') ? [selected.from, selected.to] : editor.findFrom(findInput.value, matchCase.getAttribute('aria-pressed') === 'true', selected.to, 1);
    else { range = matches.find(([from,to]) => from===selected.from && to===selected.to); range ??= matches.find(([from]) => from >= selected.to) || matches[0]; }
    if (!range) return;
    editor.replace(range[0], range[1], replaceInput.value); updateFindCount();
  }
  replaceBar.addEventListener('submit', event => { event.preventDefault(); replaceNext(); });
  replaceAllButton.addEventListener('click', () => { updateFindCount(); if (matches.length && !matches.truncated) { const ranges=matches.slice(); editor.replaceAll(ranges, replaceInput.value); updateFindCount(); } });
  findInput.addEventListener('input', updateFindCount);
  matchCase.addEventListener('click', () => {
    matchCase.setAttribute('aria-pressed', String(matchCase.getAttribute('aria-pressed') !== 'true'));
    updateFindCount(); findInput.focus();
  });
  findBar.addEventListener('submit', event => { event.preventDefault(); findDirection(1); });
  findPrev.addEventListener('click', () => findDirection(-1));
  findNext.addEventListener('click', () => findDirection(1));
  findClose.addEventListener('click', closeFind);
  findInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); findDirection(event.shiftKey ? -1 : 1); }
  });

  function onEdit() {
    editRevision++; commandRevision++;
    state.dirty = writePending || !editor.isClean(); lifecycle.changed();
    notice = ''; noticeKind = '';
    updateStatus();
    if (!findBar.hidden) updateFindCount();
  }
  body.addEventListener('keydown', event => {
    if (disposed || event.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    // A modal owns focus and shortcuts. Saving/opening the editor behind it is
    // never a side effect of typing a shortcut into the destination field.
    if (!backdrop.hidden) {
      if (event.key === 'Escape' && !busy) { hideSaveAs(); event.preventDefault(); }
      if (event.key === 'Tab') {
        const inputs = [...dialog.querySelectorAll('input:not(:disabled), button:not(:disabled)')];
        const first = inputs[0], last = inputs[inputs.length - 1];
        if (!inputs.length) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      if (mod && ['s', 'o', 'f'].includes(key)) event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      if (activeMenu) { closeMenu(true); event.preventDefault(); }
      else if (!findBar.hidden) { closeFind(); event.preventDefault(); }
      else if (!lineBar.hidden) { lineBar.hidden = true; focusEditor(); event.preventDefault(); }
      return;
    }
    if (event.key === 'F3' && !mod && !event.altKey) {
      event.preventDefault(); execute(event.shiftKey ? 'findPrev' : 'findNext'); return;
    }
    if (mod && !event.altKey) {
      let id;
      if (key === 's') id = event.shiftKey ? 'saveAs' : 'save';
      else if (key === 'o') id = 'open';
      else if (key === 'f') id = 'find';
      if (id) { event.preventDefault(); closeMenu(); execute(id); }
    }
    // CodeMirror owns undo and editing; Tab remains available for focus navigation.
  });

  if (host.commands) {
    const ready = () => { if (!valid() || !editor || !state.loaded || busy || replacing || !backdrop.hidden) throw Error('The document is not ready for commands.'); };
    const inspect = host.commands.register({id:'inspect',description:'Read a bounded slice of this open text document.',parameters:{type:'object',properties:{start:{type:'integer',minimum:0},length:{type:'integer',minimum:0,maximum:65536}}}},args => {
      ready(); if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['start','length'].includes(k))) throw Error('Provide optional start and length.');
      const text=value(), start=args.start??0, length=args.length??4096;
      if (!Number.isSafeInteger(start) || start<0 || start>text.length || !Number.isSafeInteger(length) || length<0 || length>65536) throw Error('Invalid text range.');
      const end=Math.min(text.length,start+length), boundary=pos => pos>0 && pos<text.length && /[\uD800-\uDBFF]/.test(text[pos-1]) && /[\uDC00-\uDFFF]/.test(text[pos]);
      if (boundary(start) || boundary(end)) throw Error('Text range splits a Unicode character.');
      return {path:state.path,revision:commandRevision,dirty:state.dirty,length:text.length,start,text:text.slice(start,end)};
    }); host.onDispose(inspect);
    const replace = host.commands.register({id:'replace-range',description:'Replace a UTF-16 range in the open document using its inspected revision.',parameters:{type:'object',required:['from','to','text','revision'],properties:{from:{type:'integer',minimum:0},to:{type:'integer',minimum:0},text:{type:'string',maxLength:4096},revision:{type:'integer',minimum:0}}}},args => {
      ready(); if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['from','to','text','revision'].includes(k)) || !Number.isSafeInteger(args.from) || !Number.isSafeInteger(args.to) || !Number.isSafeInteger(args.revision) || typeof args.text !== 'string' || args.text.length>4096) throw Error('Provide from, to, text and the inspected revision.');
      const text=value(), boundary=pos => pos>0 && pos<text.length && /[\uD800-\uDBFF]/.test(text[pos-1]) && /[\uDC00-\uDFFF]/.test(text[pos]);
      if (args.revision!==commandRevision) throw Error('The document changed. Inspect it again.');
      if (args.from<0 || args.to<args.from || args.to>text.length || boundary(args.from) || boundary(args.to) || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(args.text)) throw Error('Invalid UTF-16 text range or input.');
      editor.replace(args.from,args.to,args.text); return {path:state.path,revision:commandRevision,dirty:state.dirty,length:value().length};
    }); host.onDispose(replace);
    const saveCommand = host.commands.register({id:'save',description:'Save the inspected revision to My files. Supply a new path only for an untitled document.',parameters:{type:'object',required:['revision'],properties:{revision:{type:'integer',minimum:0},path:{type:'string',maxLength:1024}},additionalProperties:false}},async args => {
      ready();
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['revision','path'].includes(k)) || !Number.isSafeInteger(args.revision) || args.revision !== commandRevision) throw Error('Inspect the current document revision before saving.');
      if (state.mixedLineEndings) throw Error('Use the Save button to confirm conversion of mixed line endings.');
      const isNew = state.version === null;
      if (isNew && (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 1024)) throw Error('Provide a new My files path for this document.');
      if (!isNew && args.path !== undefined) throw Error('A saved document can only be saved to its current path.');
      const savedRevision = commandRevision;
      const result = await save(isNew ? args.path : state.path, isNew, true);
      if (!result) throw Error('The document could not be saved.');
      return {...result, savedRevision};
    }); host.onDispose(saveCommand);
  }

  setNotice('Loading editor…');
  Promise.resolve().then(() => host.tools.loadCodeMirror()).then(module => {
    if (disposed || host.signal.aborted || signedInSubject() !== owner) return;
    editor = module.createEditor({parent:area,text:state.text,wrap:state.wrap,path:state.path,dirty:state.dirty,onChange:onEdit,onSelection:scheduleInfo});
    lifecycle.changed(); host.ui.applyInputMode?.(area);
    if (!owner) { editor.setReadOnly(true); setNotice('Sign in to use your files.', 'warning'); }
    else if (!state.loaded) load();
    else setNotice('');
  }).catch(error => { if (!disposed) setNotice('Editor could not load: '+error.message, 'error'); });
  return {
    element: body,
    lifecycle: Object.freeze({snapshot:lifecycle.snapshot,subscribe:lifecycle.subscribe,quiesce:lifecycle.quiesce}),
    dispose() {
      if (disposed) return;
      disposed = true; lifecycle.close();
      body.inert = true; closeMenu();
      layoutObserver.disconnect();
      if (editor) state.text = editor.getText();
      editor?.destroy(); editor = null;
      revision++; fileCheckRevision++;
      unsubscribe();
      clearTimeout(infoTimer);
      document.removeEventListener('pointerdown', outsideMenu, true);
    }
  };
}

const ICONS = {
  document: ['M6 3h8l5 5v13H6z','M14 3v6h5','M9 13h7','M9 17h7'],
  folder: ['M3 7V5h6l2 2h10v12H3z','M3 10h18'],
  save: ['M4 3h14l3 3v15H4z','M8 3v7h9V3','M8 21v-8h9v8'],
  copy: ['M8 7h12v14H8z','M4 17H3V3h12v3'],
  refresh: ['M20 8a8 8 0 0 0-14-2L4 8','M4 3v5h5','M4 16a8 8 0 0 0 14 2l2-2','M20 21v-5h-5'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z','m16.5 16.5 4.5 4.5'],
  wrap: ['M3 6h18','M3 10h18','M3 14h12a3 3 0 0 1 0 6h-4','m13 18-2 2 2 2','M3 18h5'],
  select: ['M6 3H3v3','M18 3h3v3','M3 18v3h3','M21 18v3h-3','M9 8h6','M12 8v8'],
  undo: ['M9 7 4 12l5 5','M4 12h9a6 6 0 0 1 6 6'],
  redo: ['m15 7 5 5-5 5','M20 12h-9a6 6 0 0 0-6 6'],
  replace: ['M4 6h10','m11 3 3 3-3 3','M20 18H10','m13 15-3 3 3 3'],
  indent: ['M4 5h16','M10 10h10','M10 15h10','M4 20h16','m4 10 4 3-4 3'],
  outdent: ['M4 5h16','M10 10h10','M10 15h10','M4 20h16','m8 10-4 3 4 3'],
  more: ['M5 12h.01','M12 12h.01','M19 12h.01'],
  up: ['m6 14 6-6 6 6'],
  down: ['m6 10 6 6 6-6'],
  close: ['M5 5l14 14','M19 5 5 19'],
  lines: ['M9 5h12','M9 12h12','M9 19h12','M3 5h1','M3 12h1','M3 19h1'],
  plus: ['M12 5v14','M5 12h14'],
  minus: ['M5 12h14'],
  text: ['M4 5h16','M12 5v15','M8 20h8']
};

const STYLES = `
.codi-text-editor {
  --ce-bg: #fff; --ce-chrome: #f7f8fa; --ce-border: #dbe1e8;
  --ce-fg: #1d2835; --ce-muted: #5c6876; --ce-hover: #e8edf5;
  --ce-primary: #245fd7; --ce-primary-fg: white;
  position: relative; display: flex; flex-direction: column; width: 100%;
  min-width: 0; min-height: 0; overflow: hidden; container-type: inline-size;
  background: var(--ce-bg); color: var(--ce-fg);
  font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
}
.codi-text-editor *, .codi-text-editor *::before, .codi-text-editor *::after { box-sizing: border-box; }
.codi-text-editor button, .codi-text-editor input, .codi-text-editor textarea { font: inherit; }
.codi-text-editor button { cursor: pointer; color: inherit; }
.codi-text-editor button:disabled { opacity: .45; cursor: default; }
.codi-text-editor button:focus-visible, .codi-text-editor input:focus-visible, .codi-text-editor textarea:focus-visible { outline: 2px solid var(--ce-primary); outline-offset: -2px; }
.codi-text-editor [hidden] { display: none !important; }
.ce-header { position: relative; z-index: 6; display: flex; flex: 0 0 auto; align-items: center; gap: 6px; min-height: 40px; padding: 2px 8px; border-bottom: 1px solid var(--ce-border); background: var(--ce-chrome); }
.ce-menu-set { display: flex; align-items: center; gap: 1px; }
.ce-menu-trigger { border: 0; border-radius: 5px; padding: 6px 11px; background: transparent; }
.ce-menu-trigger:hover, .ce-menu-trigger[aria-expanded='true'] { background: var(--ce-hover); }
.ce-docname { display: flex; flex: 1 1 auto; justify-content: flex-end; align-items: center; min-width: 0; gap: 7px; color: var(--ce-muted); font-size: 12px; padding: 0 4px; }
.ce-docname > svg { flex-shrink: 0; }
.ce-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.ce-dirty-dot { width: 7px; height: 7px; border-radius: 50%; background: #e49c17; flex: none; }
.ce-mobile-menu { display: none; padding: 5px; }
.ce-popup { position: absolute; top: calc(100% - 1px); left: 0; z-index: 20; width: min(290px, calc(100% - 16px)); max-height: min(460px, 64vh); overflow-y: auto; padding: 5px; border: 1px solid var(--ce-border); border-radius: 9px; background: var(--ce-bg); box-shadow: 0 10px 30px #152a482e; }
.ce-popup-heading { padding: 8px 10px 3px; color: var(--ce-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
.ce-command { display: flex; width: 100%; align-items: center; gap: 10px; min-height: 36px; border: none; padding: 7px 10px; border-radius: 5px; background: transparent; text-align: left; }
.ce-command:hover:not([aria-disabled='true']) { background: var(--ce-hover); }
.ce-command-label { flex: 1; }
.ce-shortcut { margin-left: 6px; color: var(--ce-muted); font-size: 11px; }
.ce-command[aria-checked='true']::after { content: '✓'; color: var(--ce-primary); }
.ce-quick-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 2px; padding-left: 7px; border-left: 1px solid var(--ce-border); }
.ce-desktop-save { display: flex; flex: 0 0 auto; }
.ce-command[aria-disabled='true'] { opacity: .45; cursor: default; }
.ce-toolbar { display: none; align-items: center; gap: 5px; min-width: 0; flex: 0 0 auto; min-height: 44px; padding: 5px 9px; border-bottom: 1px solid var(--ce-border); background: var(--ce-bg); }
.ce-tool, .ce-iconbutton { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; gap: 7px; min-height: 32px; padding: 5px 10px; border: 1px solid transparent; border-radius: 6px; background: transparent; white-space: nowrap; }
.ce-tool:hover:not(:disabled), .ce-iconbutton:hover:not(:disabled) { background: var(--ce-hover); }
.ce-save-tool { background: var(--ce-primary); color: var(--ce-primary-fg) !important; }
.ce-save-tool:hover:not(:disabled) { background: #174bb5; }
.ce-editor { display: block; flex: 1 1 0; min-height: 0; min-width: 0; width: 100%; border: none; border-radius: 0; background: var(--ce-bg); color: var(--ce-fg); font: calc(14px + var(--ce-text-step, 0px))/1.6 'Cascadia Code', 'SFMono-Regular', Consolas, 'Liberation Mono', monospace !important; tab-size: 4; outline-offset: -3px; }
.ce-editor .cm-content { padding: 18px 23px; }
.ce-editor .cm-gutters { background: var(--ce-chrome); color: var(--ce-muted); border-color: var(--ce-border); }
.ce-editor .cm-activeLine, .ce-editor .cm-activeLineGutter { background: color-mix(in srgb, var(--ce-hover) 55%, transparent); }
.ce-editor .cm-cursor { border-left-color: var(--ce-fg); }
.ce-editor .cm-editor.cm-focused { outline: none; }
.ce-findbar, .ce-replacebar, .ce-linebar { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; min-width: 0; padding: 7px 10px; border-bottom: 1px solid var(--ce-border); background: var(--ce-chrome); }
.ce-find-input { min-width: 0; flex: 1; padding: 6px 9px; border: 1px solid var(--ce-border); border-radius: 6px; background: var(--ce-bg); color: var(--ce-fg); }
.ce-find-count { color: var(--ce-muted); min-width: 58px; text-align: center; font-size: 12px; }
.ce-iconbutton { width: 32px; padding: 5px; }
.ce-match-case[aria-pressed='true'] { background: var(--ce-hover); color: var(--ce-primary); border-color: var(--ce-primary); }
.ce-linebar label { display: flex; align-items: center; gap: 10px; }
.ce-line-input { width: 80px; padding: 5px 7px; border: 1px solid var(--ce-border); border-radius: 5px; background: var(--ce-bg); color: var(--ce-fg); }
.ce-line-hint { flex: 1; color: var(--ce-muted); }
.ce-dialog-error { font-size: 12px; color: #c12e39; overflow-wrap: anywhere; }
.ce-dialog-backdrop { overflow-y: auto; }
.ce-dialog { max-height: 100%; overflow-y: auto; }
.ce-status { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 29px; flex: 0 0 auto; padding: 4px 50px 4px 11px; border-top: 1px solid var(--ce-border); background: var(--ce-chrome); color: var(--ce-muted); font-size: 11px; }
.ce-status-message { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ce-status-message[data-kind='error'] { color: #c12e39; }
.ce-status-message[data-kind='warning'] { color: #ad6a00; }
.ce-metrics { display: flex; align-items: center; flex-shrink: 0; gap: 12px; white-space: nowrap; }
.ce-dialog-backdrop { position: absolute; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; padding: 16px; background: #0d1b3280; }
.ce-dialog { display: flex; flex-direction: column; gap: 14px; width: min(420px, 100%); padding: 22px; background: var(--ce-bg); border: 1px solid var(--ce-border); border-radius: 12px; box-shadow: 0 24px 50px #050d183b; }
.ce-dialog h2 { font-size: 17px; font-weight: 650; margin: 0; }
.ce-dialog label { display: flex; flex-direction: column; gap: 7px; color: var(--ce-muted); }
.ce-path-input { padding: 9px; border: 1px solid var(--ce-border); border-radius: 6px; background: var(--ce-bg); color: var(--ce-fg); }
.ce-dialog-actions { display: flex; justify-content: end; gap: 8px; }
.ce-dialog-actions button { padding: 8px 14px; border: 1px solid var(--ce-border); border-radius: 6px; background: var(--ce-chrome); }
.ce-browse-folder { align-self: flex-start; min-height: 44px; padding: 8px 14px; border: 1px solid var(--ce-border); border-radius: 6px; background: var(--ce-chrome); }
.ce-dialog-actions .ce-dialog-primary { border-color: var(--ce-primary); background: var(--ce-primary); color: white; }
.ce-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; }
@container (min-width: 521px) and (max-width: 700px) {
  .ce-menu-trigger { padding: 6px 8px; }
  .ce-tool { padding: 5px 8px; }
  .ce-docname > svg { display: none; }
  .ce-name { max-width: 130px; }
  .ce-words { display: none; }
}
@container (max-width: 520px) {
  .ce-header { min-height: 44px; padding: 3px 9px; }
  .ce-menu-set, .ce-quick-actions, .ce-desktop-save { display: none; }
  .ce-docname { justify-content: flex-start; margin-right: auto; color: var(--ce-fg); font-size: 14px; }
  .ce-name { max-width: none; }
  .ce-mobile-menu { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 44px; width: 44px; height: 40px; }
  .ce-toolbar { display: flex; order: 2; min-height: 52px; justify-content: space-around; gap: 2px; padding: 5px 7px; border-top: 1px solid var(--ce-border); border-bottom: 0; }
  .ce-toolbar .ce-tool { min-width: 44px; min-height: 40px; }
  .ce-toolbar .ce-tool-label { display: none; }
  .ce-findbar, .ce-replacebar, .ce-linebar { order: 0; }
  .ce-findbar { padding: 5px 7px; gap: 2px; }
  .ce-findbar .ce-iconbutton { width: 36px; min-height: 40px; }
  .ce-find-count { min-width: 53px; font-size: 11px; }
  .ce-find-input, .ce-line-input, .ce-path-input { font-size: 16px !important; }
  .ce-editor { order: 1; }
  .ce-status { order: 3; }
  .ce-editor { font-size: calc(16px + var(--ce-text-step, 0px)) !important; }
  .ce-editor .cm-content { padding: 14px 15px; }
  .ce-encoding, .ce-words { display: none; }
  .ce-status { min-height: 27px; }
  .ce-status-message[data-kind='error'], .ce-status-message[data-kind='warning'] { white-space: normal; overflow-wrap: anywhere; }
  .ce-shortcut { display: none; }
  .ce-popup { max-height: min(440px, 62dvh); }
}
@media (pointer: coarse) {
  .ce-command { min-height: 44px; }
  .ce-iconbutton { width: 42px; min-height: 42px; }
  .ce-menu-trigger { min-height: 40px; }
}
@media (prefers-color-scheme: dark) {
  .codi-text-editor { --ce-bg: #171c24; --ce-chrome: #202734; --ce-border: #353f50;
    --ce-fg: #e4e9f3; --ce-muted: #9aa8bb; --ce-hover: #303b4f; --ce-primary: #356de2; }
  .ce-status-message[data-kind='error'], .ce-dialog-error { color: #ff8d9a; }
  .ce-status-message[data-kind='warning'] { color: #ffcc70; }
}
`;
