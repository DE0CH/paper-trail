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

import type { HistEntry, HistStack, Pos, SerializedStacks } from './types';

const UNDO_LIMIT = 50;

export class NavStacks {
  onChange: ((nav: NavStacks) => void) | null;
  stacks: HistStack[] = [];
  activeId = 0;
  private nextId = 1;
  private nameCounter = 1;
  // Undo/redo of structural mutations (push/overwrite, fork, close, rename,
  // clear). Deliberately fragile, like everywhere else: in-memory only
  // (gone after save/reopen), and any new action clears the redo side.
  private undoStack: SerializedStacks[] = [];
  private redoStack: SerializedStacks[] = [];

  constructor(onChange: ((nav: NavStacks) => void) | null = null) {
    this.onChange = onChange;
    this.reset();
  }

  /** Fresh state for a newly opened document. Clears undo/redo. */
  reset(rootLabel = 'Start'): void {
    this.undoStack = [];
    this.redoStack = [];
    this.init(rootLabel);
    this.emit();
  }

  /** "Clear history" as a user action: undoable. */
  clearAll(rootLabel = 'Start'): void {
    this.recordUndo();
    this.init(rootLabel);
    this.emit();
  }

  private init(rootLabel: string): void {
    this.nextId = 1;
    this.nameCounter = 1;
    this.stacks = [this.mkStack(null, [{ label: rootLabel, pos: { page: 1, yRatio: 0 } }], 0)];
    this.activeId = this.stacks[0].id;
  }

  private recordUndo(): void {
    this.undoStack.push(this.serialize());
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo(): boolean { return this.undoStack.length > 0; }
  canRedo(): boolean { return this.redoStack.length > 0; }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.serialize());
    this.load(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.serialize());
    this.load(next);
    return true;
  }

  private mkStack(name: string | null, entries: HistEntry[], index: number): HistStack {
    const finalName = name ?? `Untitled ${this.nameCounter}`;
    this.nameCounter++;
    return { id: this.nextId++, name: finalName, entries, index };
  }

  renameStack(id: number, name: string): void {
    const s = this.stacks.find((st) => st.id === id);
    if (!s || !name.trim() || s.name === name.trim()) return;
    this.recordUndo();
    s.name = name.trim();
    this.emit();
  }

  renameEntry(i: number, label: string): void {
    const e = this.active.entries[i];
    if (!e || !label.trim() || e.label === label.trim()) return;
    this.recordUndo();
    e.label = label.trim();
    this.emit();
  }

  /** Re-anchor an entry of the active stack to a new position (undoable). */
  setEntryPos(i: number, pos: Pos): void {
    const e = this.active.entries[i];
    if (!e) return;
    this.recordUndo();
    e.pos = pos;
    this.emit();
  }

  get active(): HistStack {
    return this.stacks.find((s) => s.id === this.activeId) ?? this.stacks[0];
  }

  get current(): HistEntry {
    const s = this.active;
    return s.entries[s.index];
  }

  /** Keep the current entry's position in sync with where the user actually is. */
  updateCurrentPos(pos: Pos | null | undefined): void {
    if (pos && this.current) this.current.pos = pos;
  }

  /** A jump: overwrite the forward tail of the active stack, push, move cursor. */
  visit(entry: HistEntry): HistEntry {
    this.recordUndo();
    const s = this.active;
    s.entries = s.entries.slice(0, s.index + 1);
    s.entries.push(entry);
    s.index = s.entries.length - 1;
    this.emit();
    return this.current;
  }

  /**
   * A forking jump: copy the active stack up to the cursor into a new stack,
   * push the new entry there, and make it active.
   */
  fork(entry: HistEntry): HistEntry {
    this.recordUndo();
    const s = this.active;
    const copy = s.entries
      .slice(0, s.index + 1)
      .map((e) => ({ label: e.label, pos: { ...e.pos } }));
    copy.push(entry);
    const ns = this.mkStack(null, copy, copy.length - 1);
    this.stacks.push(ns);
    this.activeId = ns.id;
    this.emit();
    return this.current;
  }

  back(): HistEntry | null {
    const s = this.active;
    if (s.index === 0) return null;
    s.index--;
    this.emit();
    return this.current;
  }

  forward(): HistEntry | null {
    const s = this.active;
    if (s.index >= s.entries.length - 1) return null;
    s.index++;
    this.emit();
    return this.current;
  }

  /** Move the cursor within the active stack (clicking an entry in the panel). */
  jumpTo(i: number): HistEntry | null {
    const s = this.active;
    if (i < 0 || i >= s.entries.length) return null;
    s.index = i;
    this.emit();
    return this.current;
  }

  switchStack(id: number): HistEntry | null {
    const target = this.stacks.find((s) => s.id === id);
    if (!target) return null;
    this.activeId = id;
    this.emit();
    return this.current;
  }

  /** Returns true when the closed stack was the active one. */
  closeStack(id: number): boolean {
    if (this.stacks.length <= 1) return false;
    const i = this.stacks.findIndex((s) => s.id === id);
    if (i === -1) return false;
    this.recordUndo();
    const wasActive = this.activeId === id;
    this.stacks.splice(i, 1);
    if (wasActive) this.activeId = this.stacks[Math.max(0, i - 1)].id;
    this.emit();
    return wasActive;
  }

  canBack(): boolean {
    return this.active.index > 0;
  }

  canForward(): boolean {
    const s = this.active;
    return s.index < s.entries.length - 1;
  }

  serialize(): SerializedStacks {
    return {
      v: 3,
      activeId: this.activeId,
      nameCounter: this.nameCounter,
      stacks: this.stacks.map((s) => ({
        id: s.id,
        name: s.name,
        index: s.index,
        entries: s.entries.map((e) => ({ label: e.label, pos: e.pos })),
      })),
    };
  }

  load(data: unknown): boolean {
    try {
      const d = data as SerializedStacks;
      if (!d || d.v !== 3 || !Array.isArray(d.stacks) || !d.stacks.length) return false;
      this.stacks = d.stacks.map((s) => ({
        id: s.id,
        name: String(s.name),
        index: Math.min(Math.max(s.index | 0, 0), s.entries.length - 1),
        entries: s.entries.map((e) => ({ label: String(e.label), pos: e.pos })),
      }));
      this.nextId = Math.max(...this.stacks.map((s) => s.id)) + 1;
      this.nameCounter = Math.max(d.nameCounter | 0, this.stacks.length + 1);
      this.activeId = this.stacks.some((s) => s.id === d.activeId)
        ? d.activeId
        : this.stacks[0].id;
      this.emit();
      return true;
    } catch {
      return false;
    }
  }

  private emit(): void {
    this.onChange?.(this);
  }
}
