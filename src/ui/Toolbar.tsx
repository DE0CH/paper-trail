import { useEffect, useRef, useState, type RefObject } from 'react';
import { MOD } from '../core/platform';
import { controller, type Snapshot } from '../core/controller';
import {
  IconSidebar, IconToc, IconUndo, IconRedo, IconBack, IconForward, IconSwap,
  IconPrev, IconNext, IconGitHub,
} from './icons';

const btn = 'px-2.5 py-1 rounded-md text-fgapp hover:bg-hoverrow disabled:text-[#5a5b60] disabled:hover:bg-transparent cursor-pointer disabled:cursor-default';
const input = 'bg-inputbg text-fgapp border border-borderapp rounded-md px-2 py-1 outline-none focus:border-accent';
const sep = <span className="w-px h-5 bg-borderapp mx-1" />;
const iconBtn = `${btn} inline-flex items-center justify-center h-7 px-2`;

export default function Toolbar({
  snap,
  searchRef,
  onToggleSidebar,
  navOpen,
  onToggleNav,
}: {
  snap: Snapshot;
  searchRef: RefObject<HTMLInputElement | null>;
  onToggleSidebar: () => void;
  navOpen: boolean;
  onToggleNav: () => void;
}) {
  const [pageText, setPageText] = useState('');
  const pageFocused = useRef(false);
  const searchDebounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!pageFocused.current) setPageText(snap.docOpen ? String(snap.currentPage) : '');
  }, [snap.currentPage, snap.docOpen]);

  // Fixed label + a dot in a reserved slot: the button never changes width,
  // so neighbors don't jump as the save state changes.
  const saveTitle = snap.save === 'saving'
    ? 'Saving\u2026'
    : snap.save === 'dirty'
      ? (snap.saveBound
        ? 'Unsaved changes — auto-save is pending (' + MOD + '+S to save now)'
        : 'Unsaved changes — save your reading session to a file (' + MOD + '+S)')
      : snap.saveBound
        ? 'Session saved — changes auto-save (' + MOD + '+S to save now)'
        : 'Save your reading session to a file (' + MOD + '+S)';

  return (
    <header id="toolbar" className="flex items-center gap-1.5 h-10 px-2.5 bg-toolbar border-b border-borderapp select-none overflow-hidden whitespace-nowrap">
      <button className={iconBtn} title="Toggle sidebar (t)" onClick={onToggleSidebar}><IconSidebar /></button>
      <button
        id="btnNavToggle"
        className={`${iconBtn} ${navOpen ? 'text-accent' : ''}`}
        title="Toggle outline / pages panel"
        onClick={onToggleNav}
      ><IconToc /></button>
      {/* Desktop reaches Open via the File menu; the toolbar stays lean. */}
      {!window.ptDesktop && (
        <button className={btn} title="Open a PDF or reading-progress file (o)" onClick={() => void controller.pickFile()}>Open</button>
      )}
      <button id="btnSave" className={`${btn} inline-flex items-center`} disabled={!snap.docOpen}
        title={saveTitle}
        onClick={() => controller.saveProgressSafe()}>
        Save session
        <span className="inline-flex w-2.5 justify-center ml-1 flex-none">
          {snap.save === 'dirty' && (
            <span id="saveDirtyDot" className="w-1.5 h-1.5 rounded-full bg-white" />
          )}
          {snap.save === 'saving' && (
            <span className="w-1.5 h-1.5 rounded-full bg-dim animate-pulse" />
          )}
        </span>
      </button>
      <button id="btnLoadSession" className={btn}
        title="Load a reading session file (replaces your current reading history and position)"
        onClick={() => void controller.requestLoadSession()}>
        Load session&hellip;
      </button>
      <span className="text-dim max-w-55 overflow-hidden text-ellipsis ml-1">{snap.docTitle}</span>
      {snap.docOpen && (
        <button
          id="btnReplacePdf"
          className={`${iconBtn} text-dim`}
          title="Replace the PDF with another file, keeping your reading history (e.g. a revised version)"
          onClick={() => void controller.requestReplacePdf()}
        ><IconSwap /></button>
      )}
      <span className="flex-1" />

      <button id="btnUndo" className={iconBtn} disabled={!snap.canUndo}
        title={`Undo the last history change (${MOD}+Z)`}
        onClick={() => controller.undoHist()}><IconUndo /></button>
      <button id="btnRedo" className={iconBtn} disabled={!snap.canRedo}
        title={`Redo (${MOD}+Shift+Z)`}
        onClick={() => controller.redoHist()}><IconRedo /></button>
      {sep}
      <button id="btnBack" className={iconBtn} disabled={!snap.canBack}
        title="Back — pop up the stack (Backspace / Alt+←)"
        onClick={() => controller.goBack()}><IconBack /></button>
      <button id="btnFwd" className={iconBtn} disabled={!snap.canForward}
        title="Forward — down again (Shift+Backspace / Alt+→)"
        onClick={() => controller.goForward()}><IconForward /></button>
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
      <button className={iconBtn} title="Previous match (Shift+Enter)" onClick={() => void controller.gotoMatch(-1)}><IconPrev /></button>
      <button className={iconBtn} title="Next match (Enter)" onClick={() => void controller.gotoMatch(1)}><IconNext /></button>
      {/* Web-only: the desktop app behaves like an offline app and should
          not open browser windows from its chrome. */}
      {!window.ptDesktop && (
        <>
          {sep}
          <a
            className={`${iconBtn} text-dim hover:text-fgapp`}
            href="https://github.com/DE0CH/paper-trail"
            target="_blank"
            rel="noreferrer"
            title="Source code on GitHub"
          ><IconGitHub /></a>
        </>
      )}
    </header>
  );
}
