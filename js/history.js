// Navigation history: a list of stacks.
//
// The active stack behaves like browser history: every deliberate jump
// (link click, outline click, page jump, search jump) pushes an entry and
// moves the cursor to it; pushing while the cursor is not at the top
// overwrites (truncates) the entries above it. Back/forward move the
// cursor without modifying the stack.
//
// Cmd/Ctrl+click (or middle-click) on a link *forks* instead: the active
// stack up to the cursor is copied into a new stack (so unlike a browser
// tab opened with cmd+click, "back" still works there), the jump is pushed
// onto the copy, and the new stack becomes active. The original stack is
// left untouched, preserved in the list of stacks.
//
// Each entry stores an exact scale-independent position:
// { page (1-based), yRatio (0..1) }.

export class NavStacks {
  constructor(onChange) {
    this.onChange = onChange;
    this.reset();
  }

  reset(rootLabel = 'Start') {
    this._nextId = 1;
    this.stacks = [this._mkStack('Main', [{ label: rootLabel, pos: { page: 1, yRatio: 0 } }], 0)];
    this.activeId = this.stacks[0].id;
    this._emit();
  }

  _mkStack(name, entries, index) {
    return { id: this._nextId++, name, entries, index };
  }

  get active() {
    return this.stacks.find((s) => s.id === this.activeId) || this.stacks[0];
  }

  get current() {
    const s = this.active;
    return s.entries[s.index];
  }

  // Keep the current entry's position in sync with where the user actually is.
  updateCurrentPos(pos) {
    if (pos && this.current) this.current.pos = pos;
  }

  // A jump: overwrite the forward tail of the active stack, push, move cursor.
  visit({ label, pos }) {
    const s = this.active;
    s.entries = s.entries.slice(0, s.index + 1);
    s.entries.push({ label, pos });
    s.index = s.entries.length - 1;
    this._emit();
    return this.current;
  }

  // A forking jump: copy the active stack up to the cursor into a new stack,
  // push the new entry there, and make it active.
  fork({ label, pos }) {
    const s = this.active;
    const copy = s.entries
      .slice(0, s.index + 1)
      .map((e) => ({ label: e.label, pos: { ...e.pos } }));
    copy.push({ label, pos });
    const ns = this._mkStack(label, copy, copy.length - 1);
    this.stacks.push(ns);
    this.activeId = ns.id;
    this._emit();
    return this.current;
  }

  back() {
    const s = this.active;
    if (s.index === 0) return null;
    s.index--;
    this._emit();
    return this.current;
  }

  forward() {
    const s = this.active;
    if (s.index >= s.entries.length - 1) return null;
    s.index++;
    this._emit();
    return this.current;
  }

  // Move the cursor within the active stack (clicking an entry in the panel).
  jumpTo(i) {
    const s = this.active;
    if (i < 0 || i >= s.entries.length) return null;
    s.index = i;
    this._emit();
    return this.current;
  }

  switchStack(id) {
    const target = this.stacks.find((s) => s.id === id);
    if (!target) return null;
    this.activeId = id;
    this._emit();
    return this.current;
  }

  closeStack(id) {
    if (this.stacks.length <= 1) return false;
    const i = this.stacks.findIndex((s) => s.id === id);
    if (i === -1) return false;
    const wasActive = this.activeId === id;
    this.stacks.splice(i, 1);
    if (wasActive) this.activeId = this.stacks[Math.max(0, i - 1)].id;
    this._emit();
    return wasActive;
  }

  canBack() { return this.active.index > 0; }
  canForward() { const s = this.active; return s.index < s.entries.length - 1; }

  serialize() {
    return {
      v: 3,
      activeId: this.activeId,
      stacks: this.stacks.map((s) => ({
        id: s.id, name: s.name, index: s.index,
        entries: s.entries.map((e) => ({ label: e.label, pos: e.pos })),
      })),
    };
  }

  load(data) {
    try {
      if (!data || data.v !== 3 || !Array.isArray(data.stacks) || !data.stacks.length) {
        return false;
      }
      this.stacks = data.stacks.map((s) => ({
        id: s.id,
        name: String(s.name),
        index: Math.min(Math.max(s.index | 0, 0), s.entries.length - 1),
        entries: s.entries.map((e) => ({ label: String(e.label), pos: e.pos })),
      }));
      this._nextId = Math.max(...this.stacks.map((s) => s.id)) + 1;
      this.activeId = this.stacks.some((s) => s.id === data.activeId)
        ? data.activeId
        : this.stacks[0].id;
      this._emit();
      return true;
    } catch {
      return false;
    }
  }

  _emit() {
    if (this.onChange) this.onChange(this);
  }
}

// Render the stack list + the active stack's entries into a container.
export function renderHistoryPanel(nav, container, { onEntryClick, onStackClick, onStackClose }) {
  const frag = document.createDocumentFragment();

  if (nav.stacks.length > 1) {
    const list = document.createElement('div');
    list.className = 'stackList';
    for (const s of nav.stacks) {
      const row = document.createElement('div');
      row.className = 'stackRow' + (s.id === nav.activeId ? ' active' : '');
      row.title = s.name;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = s.name;
      const cnt = document.createElement('span');
      cnt.className = 'cnt';
      cnt.textContent = String(s.entries.length);
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '\u00d7';
      x.title = 'Close this stack';
      x.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onStackClose(s.id);
      });

      row.append(name, cnt, x);
      row.addEventListener('click', () => onStackClick(s.id));
      list.appendChild(row);
    }
    frag.appendChild(list);
  }

  const s = nav.active;
  const ul = document.createElement('ul');
  ul.className = 'hist';
  s.entries.forEach((entry, i) => {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'histItem' + (i === s.index ? ' current' : '');
    row.title = entry.label + ' \u2014 page ' + entry.pos.page;

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = entry.label;
    const pg = document.createElement('span');
    pg.className = 'pg';
    pg.textContent = 'p.' + entry.pos.page;
    row.append(lbl, pg);
    row.addEventListener('click', () => onEntryClick(i));
    li.appendChild(row);
    ul.appendChild(li);
  });
  frag.appendChild(ul);

  container.replaceChildren(frag);
  const cur = container.querySelector('.histItem.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });
}
