// Navigation history as a tree.
//
// Every deliberate jump (link click, outline click, page jump, search jump)
// creates a child of the current node and moves the cursor to it. "Back"
// moves to the parent, "forward" re-descends into the most recently used
// child. Jumping from an ancestor along a *different* link creates a new
// branch, so the full exploration history is preserved as a tree.
//
// node.pos is a scale-independent position: { page (1-based), yRatio (0..1) }.

export class NavTree {
  constructor(onChange) {
    this.onChange = onChange;
    this.reset();
  }

  reset(rootLabel = 'Start') {
    this._nextId = 1;
    this.nodes = new Map();
    this.root = this._make(null, { label: rootLabel, pos: { page: 1, yRatio: 0 } });
    this.currentId = this.root.id;
    this._emit();
  }

  _make(parentId, { label, pos }) {
    const n = {
      id: this._nextId++,
      parent: parentId,
      children: [],
      lastChild: null,
      label,
      pos,
    };
    this.nodes.set(n.id, n);
    if (parentId != null) {
      const p = this.nodes.get(parentId);
      p.children.push(n.id);
      p.lastChild = n.id;
    }
    return n;
  }

  get current() {
    return this.nodes.get(this.currentId);
  }

  // Keep the current node's position in sync with where the user actually is.
  updateCurrentPos(pos) {
    const c = this.current;
    if (c && pos) c.pos = pos;
  }

  setCurrentLabel(label) {
    const c = this.current;
    if (c) { c.label = label; this._emit(); }
  }

  // A jump to a new location: creates a child of current, moves there.
  visit({ label, pos }) {
    const n = this._make(this.currentId, { label, pos });
    this.currentId = n.id;
    this._emit();
    return n;
  }

  back() {
    const c = this.current;
    if (!c || c.parent == null) return null;
    const p = this.nodes.get(c.parent);
    p.lastChild = c.id; // remember the branch we came up from
    this.currentId = p.id;
    this._emit();
    return p;
  }

  forward() {
    const c = this.current;
    if (!c) return null;
    const cid = (c.lastChild != null && this.nodes.has(c.lastChild))
      ? c.lastChild
      : c.children[c.children.length - 1];
    if (cid == null) return null;
    this.currentId = cid;
    this._emit();
    return this.nodes.get(cid);
  }

  // Teleport within the tree (clicking a node in the panel). No new nodes.
  jump(id) {
    if (!this.nodes.has(id)) return null;
    this.currentId = id;
    this._emit();
    return this.nodes.get(id);
  }

  canBack() { return !!this.current && this.current.parent != null; }
  canForward() { return !!this.current && this.current.children.length > 0; }

  serialize() {
    return {
      v: 1,
      currentId: this.currentId,
      nodes: [...this.nodes.values()].map((n) => ({
        id: n.id, parent: n.parent, children: n.children,
        lastChild: n.lastChild, label: n.label, pos: n.pos,
      })),
    };
  }

  load(data) {
    try {
      if (!data || data.v !== 1 || !Array.isArray(data.nodes) || !data.nodes.length) return false;
      this.nodes = new Map();
      let maxId = 0;
      for (const n of data.nodes) {
        this.nodes.set(n.id, { ...n, children: n.children || [] });
        maxId = Math.max(maxId, n.id);
      }
      this._nextId = maxId + 1;
      this.root = data.nodes.find((n) => n.parent == null);
      this.root = this.nodes.get(this.root ? this.root.id : data.nodes[0].id);
      this.currentId = this.nodes.has(data.currentId) ? data.currentId : this.root.id;
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

// Render the tree into a container element.
export function renderTree(tree, container, onNodeClick) {
  const rootUl = document.createElement('ul');
  rootUl.className = 'tree';
  rootUl.appendChild(buildLi(tree.root));
  container.replaceChildren(rootUl);

  const cur = container.querySelector('.treeNode.current');
  if (cur) cur.scrollIntoView({ block: 'nearest' });

  function buildLi(n) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'treeNode' + (n.id === tree.currentId ? ' current' : '');
    row.title = n.label + ' — page ' + n.pos.page;

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = n.label;
    const pg = document.createElement('span');
    pg.className = 'pg';
    pg.textContent = 'p.' + n.pos.page;
    row.append(lbl, pg);
    row.addEventListener('click', () => onNodeClick(n.id));
    li.appendChild(row);

    if (n.children.length) {
      const ul = document.createElement('ul');
      for (const cid of n.children) {
        const child = tree.nodes.get(cid);
        if (child) ul.appendChild(buildLi(child));
      }
      li.appendChild(ul);
    }
    return li;
  }
}
