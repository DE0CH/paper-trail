import { useEffect, useRef, useState, type RefObject } from 'react';
import { controller, type Snapshot } from '../core/controller';

const btn = 'px-2.5 py-1 rounded-md text-fgapp hover:bg-hoverrow disabled:text-[#5a5b60] disabled:hover:bg-transparent cursor-pointer disabled:cursor-default';
const input = 'bg-inputbg text-fgapp border border-borderapp rounded-md px-2 py-1 outline-none focus:border-accent';
const sep = <span className="w-px h-5 bg-borderapp mx-1" />;

export default function Toolbar({
  snap,
  searchRef,
  onToggleSidebar,
}: {
  snap: Snapshot;
  searchRef: RefObject<HTMLInputElement | null>;
  onToggleSidebar: () => void;
}) {
  const [pageText, setPageText] = useState('');
  const pageFocused = useRef(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!pageFocused.current) setPageText(snap.docOpen ? String(snap.currentPage) : '');
  }, [snap.currentPage, snap.docOpen]);

  const saveLabel = snap.save === 'saving'
    ? 'Saving\u2026'
    : snap.save === 'dirty'
      ? 'Save \u2022'
      : snap.saveBound
        ? 'Saved'
        : 'Save';

  return (
    <header id="toolbar" className="flex items-center gap-1.5 h-10 px-2.5 bg-toolbar border-b border-borderapp select-none overflow-hidden whitespace-nowrap">
      <button className={btn} title="Toggle sidebar (t)" onClick={onToggleSidebar}>&#9776;</button>
      <button className={btn} title="Open a PDF or reading-progress file (o)" onClick={() => void controller.pickFile()}>Open</button>
      <button id="btnSave" className={btn} disabled={!snap.docOpen}
        title={snap.saveBound
          ? 'Reading progress auto-saves (Cmd/Ctrl+S to save now)'
          : 'Save reading progress to a file (Cmd/Ctrl+S)'}
        onClick={() => controller.saveProgressSafe()}>
        {saveLabel}
      </button>
      <span className="text-dim max-w-55 overflow-hidden text-ellipsis ml-1">{snap.docTitle}</span>
      <span className="flex-1" />

      <button id="btnUndo" className={btn} disabled={!snap.canUndo}
        title="Undo the last history change (Cmd/Ctrl+Z)"
        onClick={() => controller.undoHist()}>&#8630;</button>
      <button id="btnRedo" className={btn} disabled={!snap.canRedo}
        title="Redo (Cmd/Ctrl+Shift+Z)"
        onClick={() => controller.redoHist()}>&#8631;</button>
      {sep}
      <button id="btnBack" className={btn} disabled={!snap.canBack}
        title="Back — pop up the stack (Backspace / Alt+←)"
        onClick={() => controller.goBack()}>&larr;</button>
      <button id="btnFwd" className={btn} disabled={!snap.canForward}
        title="Forward — down again (Shift+Backspace / Alt+→)"
        onClick={() => controller.goForward()}>&rarr;</button>
      {sep}

      <input
        id="pageInput"
        className={`${input} w-11 text-center`}
        type="text"
        inputMode="numeric"
        disabled={!snap.docOpen}
        value={pageText}
        title="Go to page"
        onFocus={() => { pageFocused.current = true; }}
        onBlur={() => {
          pageFocused.current = false;
          setPageText(String(snap.currentPage));
        }}
        onChange={(e) => setPageText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          controller.gotoPage(parseInt(pageText, 10));
          (e.target as HTMLInputElement).blur();
        }}
      />
      <span id="pageCount" className="text-dim">/ {snap.numPages}</span>
      {sep}

      <button className={btn} title="Zoom out (-)" onClick={() => controller.zoomOut()}>&minus;</button>
      <span className="text-dim min-w-10 text-center">{snap.zoomPercent}%</span>
      <button className={btn} title="Zoom in (+)" onClick={() => controller.zoomIn()}>+</button>
      <button className={btn} title="Fit width (0)" onClick={() => controller.fitWidth()}>Fit</button>
      {sep}

      <input
        id="searchInput"
        ref={searchRef}
        className={`${input} w-42`}
        type="text"
        placeholder="Search  ( / )"
        disabled={!snap.docOpen}
        onChange={(e) => {
          clearTimeout(searchDebounce.current);
          const q = e.target.value.trim();
          searchDebounce.current = setTimeout(() => void controller.runSearch(q), 350);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void controller.gotoMatch(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            (e.target as HTMLInputElement).value = '';
            void controller.runSearch('', { jump: false });
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span id="searchCount" className="text-dim min-w-13 text-center">{snap.searchCount}</span>
      <button className={btn} title="Previous match (Shift+Enter)" onClick={() => void controller.gotoMatch(-1)}>&#9650;</button>
      <button className={btn} title="Next match (Enter)" onClick={() => void controller.gotoMatch(1)}>&#9660;</button>
    </header>
  );
}
