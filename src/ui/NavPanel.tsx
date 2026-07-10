// Leftmost closable panel: document outline and page thumbnails.

import { useEffect, useRef } from 'react';
import { controller, type Snapshot } from '../core/controller';
import type { OutlineNode } from '../core/types';

export type NavTab = 'outline' | 'pages';

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
          <div className="text-center text-[10.5px] text-dim mt-0.5">{n}</div>
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
  const tabBtn = (t: NavTab, label: string) => (
    <button
      className={`px-2 py-2 text-[12.5px] cursor-pointer border-b-2 ${tab === t ? 'text-fgapp border-accent' : 'text-dim border-transparent'}`}
      onClick={() => onTab(t)}
    >
      {label}
    </button>
  );

  return (
    <div id="navCol" className="flex flex-col overflow-hidden border-r border-borderapp h-full">
      <div className="flex items-center border-b border-borderapp px-1.5 flex-none">
        {tabBtn('outline', 'Outline')}
        {tabBtn('pages', 'Pages')}
        <span className="flex-1" />
        <button
          id="btnNavClose"
          className="text-dim hover:text-fgapp cursor-pointer px-1.5 text-[13px]"
          title="Close panel"
          onClick={onClose}
        >
          &times;
        </button>
      </div>
      {tab === 'outline' ? (
        <div id="outlinePanel" className="flex-1 overflow-auto p-1.5">
          {snap.outline.length
            ? <OutlineTree nodes={snap.outline} />
            : <div className="text-dim text-center p-3">No outline in this document</div>}
        </div>
      ) : (
        <Thumbnails snap={snap} />
      )}
    </div>
  );
}
