import { useEffect, useRef, useState } from 'react';
import { controller, type Snapshot } from '../core/controller';
import type { OutlineNode } from '../core/types';

const rowBase = 'flex items-center gap-1.5 px-1.5 py-0.5 my-px rounded-md cursor-pointer text-dim hover:bg-hoverrow hover:text-fgapp';
const rowActive = 'bg-accentsoft text-fgapp outline outline-1 outline-[rgba(79,140,255,0.45)]';

function StackRow({ snap, id, name, count }: {
  snap: Snapshot; id: number; name: string; count: number;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const active = id === snap.activeStackId;
  return (
    <div
      className={`stackRow ${rowBase} ${active ? rowActive : ''}`}
      title={`${name} — double-click to rename`}
      onClick={() => controller.stackSwitch(id)}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="rename flex-1 min-w-0 bg-inputbg text-fgapp border border-accent rounded px-1 outline-none"
          defaultValue={name}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              controller.stackRename(id, (e.target as HTMLInputElement).value);
              setEditing(false);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          onBlur={(e) => {
            controller.stackRename(id, e.target.value);
            setEditing(false);
          }}
        />
      ) : (
        <span
          className="name flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {name}
        </span>
      )}
      <span className="cnt text-[11px] text-dim flex-none">{count}</span>
      <button
        className="x flex-none px-1 rounded text-dim hover:bg-[#45474e] hover:text-fgapp cursor-pointer"
        title="Close this stack"
        onClick={(e) => {
          e.stopPropagation();
          controller.stackClose(id);
        }}
      >
        &times;
      </button>
    </div>
  );
}

function OutlineTree({ nodes }: { nodes: OutlineNode[] }) {
  return (
    <ul className="outline list-none m-0 pl-3">
      {nodes.map((n, i) => (
        <li key={i}>
          <div
            className="outlineItem px-1.5 py-0.5 rounded-md cursor-pointer text-dim hover:bg-hoverrow hover:text-fgapp overflow-hidden text-ellipsis whitespace-nowrap"
            title={n.title}
            onClick={(e) => void controller.outlineJump(n, e.metaKey || e.ctrlKey)}
          >
            {n.title}
          </div>
          {n.children.length > 0 && <OutlineTree nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}

export default function Sidebar({
  snap, widths, onStartResize,
}: {
  snap: Snapshot;
  widths: { stacks: number; sidebar: number };
  onStartResize: (which: 'stacks' | 'sidebar', e: React.PointerEvent) => void;
}) {
  const [tab, setTab] = useState<'history' | 'outline'>('history');
  const histPanelRef = useRef<HTMLDivElement>(null);

  const active = snap.stacks.find((s) => s.id === snap.activeStackId) ?? snap.stacks[0];

  useEffect(() => {
    histPanelRef.current
      ?.querySelector('.histItem.current')
      ?.scrollIntoView({ block: 'nearest' });
  }, [snap.activeIndex, snap.activeStackId]);

  const tabBtn = (t: 'history' | 'outline', label: string) => (
    <button
      className={`px-2.5 py-2 text-[12.5px] cursor-pointer border-b-2 ${tab === t ? 'text-fgapp border-accent' : 'text-dim border-transparent'}`}
      onClick={() => setTab(t)}
    >
      {label}
    </button>
  );

  return (
    <aside
      id="sidebar"
      className="flex flex-row bg-panel border-r border-borderapp"
      style={{ width: widths.sidebar, minWidth: widths.sidebar }}
    >
      <div
        id="stacksCol"
        className="flex flex-col overflow-hidden border-r border-borderapp"
        style={{ width: widths.stacks, minWidth: widths.stacks }}
      >
        <div className="text-dim text-[12.5px] px-2.5 py-2 border-b border-borderapp">Stacks</div>
        <div id="stacksPanel" className="flex-1 overflow-auto p-1.5">
          {snap.stacks.map((s) => (
            <StackRow key={s.id} snap={snap} id={s.id} name={s.name} count={s.entries.length} />
          ))}
        </div>
      </div>

      <div
        id="resizeStacks"
        className="flex-none w-[5px] -mx-0.5 cursor-col-resize z-10 hover:bg-[rgba(79,140,255,0.35)]"
        title="Drag to resize"
        onPointerDown={(e) => onStartResize('stacks', e)}
      />

      <div id="sideCol" className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <div className="flex items-center border-b border-borderapp px-1.5">
          {tabBtn('history', 'History')}
          {tabBtn('outline', 'Outline')}
          <span className="flex-1" />
          <button
            className="text-[11px] text-dim hover:text-fgapp cursor-pointer px-1.5"
            title="Clear navigation history (all stacks)"
            onClick={() => controller.clearHistory()}
          >
            clear
          </button>
        </div>

        <div
          ref={histPanelRef}
          id="historyPanel"
          className={`flex-1 overflow-auto p-1.5 ${tab !== 'history' ? 'hidden' : ''}`}
        >
          <ul className="hist list-none m-0 p-0">
            {active?.entries.map((entry, i) => (
              <li key={i}>
                <div
                  className={`histItem ${rowBase} ${i === snap.activeIndex ? `current ${rowActive}` : ''}`}
                  title={`${entry.label} — page ${entry.pos.page}`}
                  onClick={() => controller.histEntryClick(i)}
                >
                  <span className="lbl flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{entry.label}</span>
                  <span className="pg text-[11px] text-dim flex-none">p.{entry.pos.page}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div
          id="outlinePanel"
          className={`flex-1 overflow-auto p-1.5 ${tab !== 'outline' ? 'hidden' : ''}`}
        >
          {snap.outline.length
            ? <OutlineTree nodes={snap.outline} />
            : <div className="text-dim text-center p-3">No outline in this document</div>}
        </div>
      </div>

      <div
        id="resizeSidebar"
        className="flex-none w-[5px] -mx-0.5 cursor-col-resize z-10 hover:bg-[rgba(79,140,255,0.35)]"
        title="Drag to resize"
        onPointerDown={(e) => onStartResize('sidebar', e)}
      />
    </aside>
  );
}
