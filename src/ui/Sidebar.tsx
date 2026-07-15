import { useEffect, useRef, useState } from 'react';
import { MOD } from '../core/platform';
import { controller, type Snapshot } from '../core/controller';
import NavPanel, { type NavTab } from './NavPanel';
import { IconAnchor, IconClose, IconCopy, IconEdit, IconPlus, IconTrash } from './icons';

// 22px rows on the 13px font (≈1.7em — the classic dark-IDE list
// metric): the 18.2px text line gets real air inside the highlight,
// and rows touch instead of leaving phantom gaps.
const rowBase = 'flex items-center gap-1.5 h-6 px-1.5 rounded-md cursor-pointer text-dim hover:bg-hoverrow hover:text-fgapp';
// The rename input must occupy the SAME box as the name span so the text
// never shifts on edit — match it on BOTH axes: the span's font-size and
// its inherited line-height (body is 13px/1.4, so a 12px child's line box
// is 16.8px). A fixed height is the trap: the old `h-5` (20px) was tuned
// for the 13px font and outlived the 13→12px change, leaving the text in
// a box 3.2px taller than the span (centres still align, so the box test
// passed, but the text visibly shifted). Sizing by line-height keeps the
// two boxes identical whatever the font. Horizontal padding is cancelled
// by an equal negative margin; the accent outline is an INSET RING
// (box-shadow, no layout), never a border (a 1px border would push the
// text 1px right and eat 1px of height).
const renameCls = 'rename flex-1 min-w-0 leading-[1.4] px-1 -mx-1 bg-inputbg text-fgapp text-[12px] ring-1 ring-inset ring-accent rounded outline-none';
const rowActive = 'bg-accentsoft text-fgapp outline outline-1 outline-[rgba(79,140,255,0.45)]';
// One shape for every small row button; the close button additionally
// keeps a permanent flex slot so all rows align on it.
const toolBtn = 'inline-flex items-center justify-center w-5 h-5 rounded text-dim hover:bg-[#45474e] hover:text-fgapp cursor-pointer';
// Hover tools overlay the text instead of reserving space: absolutely
// positioned just left of the close slot, on the row's own background.
const toolsOverlay = 'absolute inset-y-0 hidden group-hover:flex items-center gap-1.5 pl-1 bg-inherit';

function StackRow({ snap, id, name }: {
  snap: Snapshot; id: number; name: string;
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
      className={`stackRow group relative ${rowBase} ${active ? rowActive : ''}`}
      data-id={id}
      title={`${name} — double-click to rename`}
      onClick={() => controller.stackSwitch(id)}
    >
      {editing ? (
        <input
          ref={inputRef}
          className={renameCls}
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
          className="name flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px]"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {name}
        </span>
      )}
      {!editing && (
        <span className={`${toolsOverlay} right-[22px]`}>
          <button
            className={`editName ${toolBtn}`}
            title="Rename this trail"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <IconEdit />
          </button>
          <button
            className={`dup ${toolBtn}`}
            title="Duplicate this trail"
            onClick={(e) => {
              e.stopPropagation();
              controller.stackDuplicate(id);
            }}
          >
            <IconCopy />
          </button>
        </span>
      )}
      {!editing && (
        <button
          className={`x ${toolBtn} flex-none ${active ? '' : 'opacity-0'} group-hover:opacity-100`}
          title="Close this trail"
          onClick={(e) => {
            e.stopPropagation();
            controller.stackClose(id);
          }}
        >
          <IconClose />
        </button>
      )}
    </div>
  );
}

function HistRow({ label, page, current, index, removable }: {
  label: string; page: number; current: boolean; index: number; removable: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // History rows are addressed by index, so a structural history change
  // (mark, clear, remove, undo…) can move this row onto a DIFFERENT
  // entry while a rename is open — and native menu actions don't blur
  // the input first. Cancel the editor instead of ever committing the
  // stale text to whatever entry now sits at this index. The ref also
  // vetoes the blur-commit in case the unmounting input still blurs.
  const cancelled = useRef(false);
  useEffect(() => {
    if (editing) {
      cancelled.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
      return controller.hist.onStructureChange(() => {
        cancelled.current = true;
        setEditing(false);
      });
    }
  }, [editing]);

  return (
    <div
      className={`histItem group relative ${rowBase} ${current ? `current ${rowActive}` : ''}`}
      data-idx={index}
      title={`${label} — page ${page} — double-click to rename`}
      onClick={() => controller.histEntryClick(index)}
    >
      {editing ? (
        <input
          ref={inputRef}
          className={renameCls}
          defaultValue={label}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              if (!cancelled.current) controller.entryRename(index, (e.target as HTMLInputElement).value);
              setEditing(false);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          onBlur={(e) => {
            if (!cancelled.current) controller.entryRename(index, e.target.value);
            setEditing(false);
          }}
        />
      ) : (
        <span
          className="lbl flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12px]"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {label}
        </span>
      )}
      {!editing && (
        <span className={`${toolsOverlay} ${removable ? 'right-[22px]' : 'right-1.5'}`}>
          <button
            className={`editName ${toolBtn}`}
            title="Rename this entry"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            <IconEdit />
          </button>
          <button
            className={`setPos ${toolBtn}`}
            title="Set this entry to the current position"
            onClick={(e) => {
              e.stopPropagation();
              controller.entrySetPos(index);
            }}
          >
            <IconAnchor />
          </button>
        </span>
      )}
      {!editing && removable && (
        <button
          className={`rmEntry ${toolBtn} flex-none ${current ? '' : 'opacity-0'} group-hover:opacity-100`}
          title="Remove this entry from the trail"
          onClick={(e) => {
            e.stopPropagation();
            controller.entryRemove(index);
          }}
        >
          <IconClose />
        </button>
      )}
    </div>
  );
}

export default function Sidebar({
  snap, widths, navOpen, navTab, onNavTab, onNavClose, onStartResize,
}: {
  snap: Snapshot;
  widths: { nav: number; stacks: number; side: number };
  navOpen: boolean;
  navTab: NavTab;
  onNavTab: (t: NavTab) => void;
  onNavClose: () => void;
  onStartResize: (which: 'nav' | 'stacks' | 'side', e: React.PointerEvent) => void;
}) {
  const histPanelRef = useRef<HTMLDivElement>(null);

  const active = snap.stacks.find((s) => s.id === snap.activeStackId) ?? snap.stacks[0];

  useEffect(() => {
    histPanelRef.current
      ?.querySelector('.histItem.current')
      ?.scrollIntoView({ block: 'nearest' });
  }, [snap.activeIndex, snap.activeStackId]);

  return (
    <aside
      id="sidebar"
      className="flex flex-row flex-none bg-panel border-r border-borderapp"
    >
      {navOpen && (
        <>
          <div style={{ width: widths.nav, minWidth: widths.nav }} className="flex">
            <div className="flex-1 min-w-0">
              <NavPanel snap={snap} tab={navTab} onTab={onNavTab} onClose={onNavClose} />
            </div>
          </div>
          <div
            id="resizeNav"
            className="flex-none w-[5px] -mx-0.5 cursor-col-resize z-10 hover:bg-[rgba(79,140,255,0.35)]"
            title="Drag to resize"
            onPointerDown={(e) => onStartResize('nav', e)}
          />
        </>
      )}

      <div
        id="stacksCol"
        className="flex flex-col overflow-hidden border-r border-borderapp"
        style={{ width: widths.stacks, minWidth: widths.stacks }}
      >
        {/* px-1.5 puts the header label's text on the same x as the row
            labels below it (panel p-1.5 + row px-1.5 = header pl-1.5 + px-1.5). */}
        <div className="flex items-center h-8 flex-none border-b border-borderapp pl-1.5 pr-2">
          <span className="text-dim text-[12px] px-1.5">Trails</span>
          <span className="flex-1" />
          <button
            id="btnNewTrail"
            className="inline-flex items-center justify-center w-7 h-7 rounded text-dim hover:text-fgapp hover:bg-hoverrow cursor-pointer"
            title="Start a new trail from the current position"
            onClick={() => controller.stackNew()}
          >
            <IconPlus />
          </button>
        </div>
        <div id="stacksPanel" className="flex-1 overflow-auto p-1.5">
          {snap.stacks.map((s) => (
            <StackRow key={s.id} snap={snap} id={s.id} name={s.name} />
          ))}
        </div>
      </div>

      <div
        id="resizeStacks"
        className="flex-none w-[5px] -mx-0.5 cursor-col-resize z-10 hover:bg-[rgba(79,140,255,0.35)]"
        title="Drag to resize"
        onPointerDown={(e) => onStartResize('stacks', e)}
      />

      <div
        id="sideCol"
        className="flex flex-col overflow-hidden"
        style={{ width: widths.side, minWidth: widths.side }}
      >
        {/* px-1.5: same shared label inset as the Trails header and rows. */}
        <div className="flex items-center h-8 flex-none border-b border-borderapp pl-1.5 pr-2">
          <span className="text-dim text-[12px] px-1.5">History</span>
          <span className="flex-1" />
          <button
            id="btnMark"
            className="inline-flex items-center justify-center w-7 h-7 rounded text-dim hover:text-fgapp hover:bg-hoverrow cursor-pointer"
            title={`Mark this spot — add the current position to the trail; ${MOD}-click to mark it in a new trail`}
            onClick={(e) => controller.markPosition(e.metaKey || e.ctrlKey)}
          >
            <IconPlus />
          </button>
          <button
            id="btnClearHistory"
            className="inline-flex items-center justify-center w-7 h-7 rounded text-dim hover:text-fgapp hover:bg-hoverrow cursor-pointer"
            title="Clear reading history (all trails)"
            onClick={() => controller.clearHistory()}
          >
            <IconTrash />
          </button>
        </div>

        <div ref={histPanelRef} id="historyPanel" className="flex-1 overflow-auto p-1.5">
          <ul className="hist list-none m-0 p-0">
            {active?.entries.map((entry, i) => (
              <li key={i}>
                <HistRow
                  label={entry.label}
                  page={entry.pos.page}
                  current={i === snap.activeIndex}
                  index={i}
                  removable={(active?.entries.length ?? 0) > 1}
                />
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div
        id="resizeSidebar"
        className="flex-none w-[5px] -mx-0.5 cursor-col-resize z-10 hover:bg-[rgba(79,140,255,0.35)]"
        title="Drag to resize"
        onPointerDown={(e) => onStartResize('side', e)}
      />
    </aside>
  );
}
