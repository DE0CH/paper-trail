// Leftmost closable panel: document outline and page thumbnails.

import { useEffect, useRef, useState } from 'react';
import { controller, type Snapshot } from '../core/controller';
import type { OutlineNode } from '../core/types';
import { IconChevron, IconClose, IconCollapseAll, IconExpandAll } from './icons';

export type NavTab = 'outline' | 'pages';

/** Expand All / Collapse All broadcast: bump `v` to re-apply `open`. */
type ForceAll = { v: number; open: boolean };

function OutlineItem({ n, forceAll }: { n: OutlineNode; forceAll: ForceAll }) {
  // Initial state honors the last broadcast: items mounting under a
  // collapsed-all tree start closed. (Initializing open and correcting
  // in an effect painted a fully-expanded flash first.)
  const [open, setOpen] = useState(forceAll.v === 0 || forceAll.open);
  const applied = useRef(forceAll.v);
  useEffect(() => {
    if (forceAll.v !== applied.current) {
      applied.current = forceAll.v;
      setOpen(forceAll.open);
    }
  }, [forceAll]);
  const hasKids = n.children.length > 0;
  return (
    <li>
      <div
        className="outlineItem flex items-center h-6 px-1.5 rounded-md cursor-pointer text-dim hover:bg-hoverrow hover:text-fgapp text-[12px]"
        title={n.title}
        onClick={(e) => void controller.outlineJump(n, e.metaKey || e.ctrlKey)}
      >
        {hasKids ? (
          <button
            className={`outlineToggle flex-none inline-flex items-center justify-center w-4 h-4 -ml-1 mr-0.5 rounded text-dim hover:text-fgapp hover:bg-[#45474e] cursor-pointer transition-transform ${open ? 'rotate-90' : ''}`}
            title={open ? 'Collapse section' : 'Expand section'}
            onClick={(e) => {
              e.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            <IconChevron />
          </button>
        ) : (
          <span className="w-4 mr-0.5 -ml-1 flex-none" />
        )}
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{n.title}</span>
      </div>
      {hasKids && open && <OutlineTree nodes={n.children} forceAll={forceAll} />}
    </li>
  );
}

function OutlineTree({ nodes, forceAll }: { nodes: OutlineNode[]; forceAll: ForceAll }) {
  return (
    <ul className="outlineTree list-none m-0 pl-3">
      {nodes.map((n, i) => <OutlineItem key={i} n={n} forceAll={forceAll} />)}
    </ul>
  );
}

const THUMB_W = 110;

function Thumbnails({ snap }: { snap: Snapshot }) {
  const listRef = useRef<HTMLDivElement>(null);
  const renderedRef = useRef(new Set<number>());

  // Reset thumbnail cache when the document changes.
  useEffect(() => {
    renderedRef.current.clear();
  }, [snap.docTitle, snap.numPages]);

  useEffect(() => {
    const list = listRef.current;
    if (!list || !snap.docOpen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const holder = en.target as HTMLElement;
          const pageNumber = Number(holder.dataset.thumbPage);
          if (renderedRef.current.has(pageNumber)) continue;
          renderedRef.current.add(pageNumber);
          void renderThumb(holder, pageNumber);
        }
      },
      { root: list, rootMargin: '300px' },
    );
    list.querySelectorAll('[data-thumb-page]').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [snap.docOpen, snap.docTitle, snap.numPages]);

  async function renderThumb(holder: HTMLElement, pageNumber: number): Promise<void> {
    const rec = controller.viewer.pages[pageNumber - 1];
    if (!rec) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = (THUMB_W / rec.vp1.width) * dpr;
    const vp = rec.page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    c.className = 'block w-full rounded-xs';
    try {
      await rec.page.render({
        canvas: c,
        canvasContext: c.getContext('2d', { alpha: false })!,
        viewport: vp,
      }).promise;
      holder.replaceChildren(c);
    } catch (e) {
      console.warn('thumbnail render failed', e);
      renderedRef.current.delete(pageNumber);
    }
  }

  if (!snap.docOpen) return <div className="text-dim text-center p-3">No document</div>;

  const aspect = controller.viewer.pages[0]
    ? controller.viewer.pages[0].vp1.height / controller.viewer.pages[0].vp1.width
    : 1.4;

  return (
    <div ref={listRef} className="flex-1 overflow-auto p-2" id="thumbList">
      {Array.from({ length: snap.numPages }, (_, i) => i + 1).map((n) => (
        <div
          key={`${snap.docTitle}:${n}`}
          className={`thumb mb-2 cursor-pointer rounded-sm p-0.5 ${n === snap.currentPage ? 'outline-2 outline-accent' : 'hover:outline-2 hover:outline-[rgba(79,140,255,0.4)]'}`}
          onClick={() => controller.gotoPage(n)}
          title={`Page ${n}`}
        >
          <div
            data-thumb-page={n}
            className="bg-white/90 w-full"
            style={{ aspectRatio: `1 / ${aspect}` }}
          />
          <div className="text-center text-[10px] text-dim mt-0.5">{n}</div>
        </div>
      ))}
    </div>
  );
}

export default function NavPanel({
  snap, tab, onTab, onClose,
}: {
  snap: Snapshot;
  tab: NavTab;
  onTab: (t: NavTab) => void;
  onClose: () => void;
}) {
  const [forceAll, setForceAll] = useState<ForceAll>({ v: 0, open: true });
  const hasSections = snap.outline.some((n) => n.children.length > 0);

  // The active-tab underline is an inset box-shadow, NOT a bottom border:
  // a 2px border (even balanced by a transparent top border) centres the
  // label inside a 32px content box while the border-less Trails/History
  // labels centre inside the full 36px, so sub-pixel rounding drifted the
  // three header labels ~1px apart. A box-shadow draws the same 2px accent
  // underline without a layout box, so the tab centres in the full 36px —
  // identical to the other headers — and can't shift on active/inactive.
  const tabBtn = (t: NavTab, label: string) => (
    <button
      className={`inline-flex items-center h-full px-2 text-[12px] cursor-pointer ${tab === t ? 'text-fgapp shadow-[inset_0_-2px_0_0_var(--color-accent)]' : 'text-dim'}`}
      onClick={() => onTab(t)}
    >
      {label}
    </button>
  );

  // flex-none: header buttons never shrink, or the close button would
  // compress off the shared right-edge axis on narrow panels.
  const headerBtn = 'flex-none inline-flex items-center justify-center self-center w-7 h-7 rounded text-dim hover:text-fgapp hover:bg-hoverrow cursor-pointer';

  return (
    <div id="navCol" className="flex flex-col overflow-hidden border-r border-borderapp h-full">
      <div className="flex items-stretch h-8 border-b border-borderapp pl-1.5 pr-2 flex-none">
        {/* The tabs give way on narrow panels; the buttons hold their
            size so the close button stays on the shared right axis. */}
        <div className="flex items-stretch min-w-0 overflow-hidden">
          {tabBtn('outline', 'Outline')}
          {tabBtn('pages', 'Pages')}
        </div>
        <span className="flex-1" />
        {tab === 'outline' && hasSections && (
          <>
            <button
              id="btnOutlineExpand"
              className={headerBtn}
              title="Expand all sections"
              onClick={() => setForceAll((f) => ({ v: f.v + 1, open: true }))}
            >
              <IconExpandAll />
            </button>
            <button
              id="btnOutlineCollapse"
              className={headerBtn}
              title="Collapse all sections"
              onClick={() => setForceAll((f) => ({ v: f.v + 1, open: false }))}
            >
              <IconCollapseAll />
            </button>
          </>
        )}
        <button
          id="btnNavClose"
          className="flex-none inline-flex items-center justify-center self-center w-7 h-7 rounded text-dim hover:text-fgapp hover:bg-hoverrow cursor-pointer"
          title="Close panel"
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>
      {tab === 'outline' ? (
        <div id="outlinePanel" className="flex-1 overflow-auto p-1.5">
          {snap.outline.length
            ? <OutlineTree nodes={snap.outline} forceAll={forceAll} />
            : <div className="text-dim text-center p-3">No outline in this document</div>}
        </div>
      ) : (
        <Thumbnails snap={snap} />
      )}
    </div>
  );
}
