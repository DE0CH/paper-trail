import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MOD } from '../core/platform';
import { controller } from '../core/controller';
import { IconClose } from './icons';
import { loadUI, saveUI } from '../core/store';
import Toolbar from './Toolbar';
import Sidebar from './Sidebar';
import Welcome from './Welcome';

// Each panel owns its width independently: resizing, closing, or opening
// one panel never changes the others' sizes — neighbors just shift and the
// viewer absorbs the difference.
const MIN_W = { nav: 90, stacks: 80, side: 150 } as const;
const VIEWER_MIN = 260;

const clampW = (v: number, min: number, max: number) =>
  Math.min(Math.max(min, max), Math.max(min, v));

type Widths = { nav: number; stacks: number; side: number };

function initialWidths(): Widths {
  const ui = loadUI();
  return {
    nav: clampW(ui.navW ?? 150, MIN_W.nav, 500),
    stacks: clampW(ui.stacksW ?? 150, MIN_W.stacks, 500),
    side: clampW(ui.sideW ?? 290, MIN_W.side, 800),
  };
}

export default function App() {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [widths, setWidths] = useState(initialWidths);
  const [dragOver, setDragOver] = useState(false);
  const [navOpen, setNavOpen] = useState(() => loadUI().navOpen ?? true);
  const [navTab, setNavTab] = useState<'outline' | 'pages'>(() => loadUI().navTab ?? 'outline');

  const toggleNav = () => setNavOpen((v) => {
    saveUI({ navOpen: !v });
    return !v;
  });
  const pickNavTab = (t: 'outline' | 'pages') => {
    saveUI({ navTab: t });
    setNavTab(t);
  };

  // Attach the imperative core once.
  useEffect(() => {
    controller.attach(containerRef.current!, viewerRef.current!, previewRef.current!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const focusSearch = () => {
        searchRef.current?.focus();
        searchRef.current?.select();
      };
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        focusSearch();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        controller.saveProgressSafe();
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        // Text inputs keep their native undo (early return above).
        e.preventDefault();
        if (e.shiftKey) controller.redoHist(); else controller.undoHist();
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      switch (e.key) {
        case 'Backspace':
          e.preventDefault();
          if (e.shiftKey) controller.goForward(); else controller.goBack();
          break;
        case 'ArrowLeft':
          if (e.altKey) { e.preventDefault(); controller.goBack(); }
          break;
        case 'ArrowRight':
          if (e.altKey) { e.preventDefault(); controller.goForward(); }
          break;
        case '/':
          e.preventDefault();
          focusSearch();
          break;
        case '+': case '=': controller.zoomIn(); break;
        case '-': controller.zoomOut(); break;
        case '0': controller.fitWidth(); break;
        case 't': setSidebarVisible((v) => !v); break;
        case 'm': controller.markPosition(e.shiftKey); break;
        case 'o': void controller.pickFile(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Desktop shell integration: inset traffic lights and OS file opens
  // (Open With…, Dock-icon drops, recent documents, File > Open).
  useEffect(() => {
    if (!window.ptDesktop) return;
    if (window.ptDesktop.platform === 'darwin') document.body.classList.add('desktopMac');
    window.ptDesktop.onOpenFile(({ name, data }) => {
      void controller.openFile(new File([data], name));
    });
  }, []);

  // Native menu actions when running inside the Electron desktop shell.
  useEffect(() => {
    // If a text field has focus, type the character there and report true.
    const typeInEditable = (ch: string): boolean => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return false;
      document.execCommand('insertText', false, ch);
      return true;
    };
    window.ptDesktop?.onMenu((action) => {
      switch (action) {
        case 'open': void controller.pickFile(); break;
        case 'save': controller.saveProgressSafe(); break;
        case 'load-session': void controller.requestLoadSession(); break;
        case 'new-session': controller.newSession(); break;
        case 'replace-pdf': void controller.requestReplacePdf(); break;
        case 'back': controller.goBack(); break;
        case 'forward': controller.goForward(); break;
        case 'undo':
        case 'redo': {
          // In text fields the menu item falls back to text-editing undo.
          const el = document.activeElement as HTMLElement | null;
          if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
            document.execCommand(action);
          } else if (action === 'undo') {
            controller.undoHist();
          } else {
            controller.redoHist();
          }
          break;
        }
        case 'zoom-in': controller.zoomIn(); break;
        case 'zoom-out': controller.zoomOut(); break;
        case 'fit': controller.fitWidth(); break;
        case 'find':
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        // Bare-letter menu accelerators (m / M / t) fire even while a text
        // field has focus; re-insert the character there instead.
        case 'toggle-sidebar':
          if (typeInEditable('t')) break;
          setSidebarVisible((v) => !v);
          break;
        case 'toggle-nav': toggleNav(); break;
        case 'mark':
          if (typeInEditable('m')) break;
          controller.markPosition();
          break;
        case 'mark-branch':
          if (typeInEditable('M')) break;
          controller.markPosition(true);
          break;
        case 'clear-history': controller.clearHistory(); break;
        case 'help':
          controller.showToast(
            `Backspace: back \u00b7 Shift+Backspace: forward \u00b7 ${MOD}+click link: fork \u00b7 /: search \u00b7 ${MOD}+S: save progress`,
            6000,
          );
          break;
        default: break;
      }
    });
  }, []);

  // Drag & drop.
  useEffect(() => {
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      depth++;
      setDragOver(true);
    };
    const over = (e: DragEvent) => e.preventDefault();
    const leave = (e: DragEvent) => {
      e.preventDefault();
      if (--depth <= 0) { depth = 0; setDragOver(false); }
    };
    const drop = (e: DragEvent) => {
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      if (e.dataTransfer) void controller.openDropped(e.dataTransfer);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, []);

  // Re-fit on window resize.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.refitIfNeeded(), 200);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Panel resizing: each divider resizes exactly one panel; the others keep
  // their widths and shift. The only global constraint is that the viewer
  // keeps a minimum width.
  const startResize = (which: 'nav' | 'stacks' | 'side', e: React.PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('bg-[rgba(79,140,255,0.35)]');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const start = { ...widths };
    const othersSum = (navOpen && which !== 'nav' ? start.nav : 0)
      + (which !== 'stacks' ? start.stacks : 0)
      + (which !== 'side' ? start.side : 0);
    const max = Math.max(MIN_W[which], window.innerWidth - VIEWER_MIN - othersSum);
    const move = (ev: PointerEvent) => {
      const w = clampW(start[which] + ev.clientX - startX, MIN_W[which], max);
      setWidths((prev) => ({ ...prev, [which]: w }));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.classList.remove('bg-[rgba(79,140,255,0.35)]');
      document.body.classList.remove('resizing');
      setWidths((prev) => {
        saveUI({
          navW: Math.round(prev.nav),
          stacksW: Math.round(prev.stacks),
          sideW: Math.round(prev.side),
        });
        return prev;
      });
      controller.refitIfNeeded();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };

  return (
    <div className="flex flex-col h-full">
      <Toolbar
        snap={snap}
        searchRef={searchRef}
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        navOpen={navOpen}
        onToggleNav={toggleNav}
      />
      <div className="flex flex-1 min-h-0">
        {sidebarVisible && (
          <Sidebar
            snap={snap}
            widths={widths}
            navOpen={navOpen}
            navTab={navTab}
            onNavTab={pickNavTab}
            onNavClose={toggleNav}
            onStartResize={startResize}
          />
        )}
        <div className="relative flex-1 min-w-0 flex flex-col">
          {snap.mismatch && (
            <div
              id="mismatchBanner"
              className="flex items-center gap-2 px-3 py-1.5 bg-[#4a3a12] text-[#f0d48a] border-b border-[#6b5518] text-[12.5px]"
            >
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                This session was saved with <b>{snap.mismatch.savedName}</b>, but{' '}
                <b>{snap.mismatch.openName}</b> is open.
              </span>
              <button
                id="btnAdoptPdf"
                className="flex-none px-2 py-0.5 rounded-md bg-[#6b5518] hover:brightness-110 cursor-pointer"
                title="Make this PDF the session's PDF — its name is written to the session file"
                onClick={() => controller.adoptCurrentPdf()}
              >
                Use this PDF
              </button>
              <button
                id="btnMismatchDismiss"
                className="flex-none inline-flex items-center self-stretch px-1.5 cursor-pointer hover:text-white"
                title="Dismiss this warning"
                onClick={() => controller.dismissMismatch()}
              >
                <IconClose />
              </button>
            </div>
          )}
          <div
            ref={containerRef}
            id="viewerContainer"
            tabIndex={0}
            className="relative flex-1 overflow-auto outline-none"
          >
            <div ref={viewerRef} id="viewer" className="pb-[60vh]" />
            <Welcome snap={snap} />
          </div>
        </div>
      </div>

      {/* hover preview popup (imperatively driven by core/preview.ts) */}
      <div
        ref={previewRef}
        id="preview"
        className="hidden fixed z-50 bg-white border border-borderapp rounded-lg shadow-[0_8px_28px_rgba(0,0,0,0.5)] overflow-hidden"
      >
        <div className="previewScroll absolute inset-0 bottom-2 overflow-auto">
          <div className="previewContent" />
        </div>
        <div className="previewPage absolute right-1.5 bottom-3 text-[11px] text-[#555] bg-white/85 px-1.5 rounded z-10">p.</div>
        <div className="previewResize absolute left-0 right-0 bottom-0 h-2 cursor-ns-resize bg-[#e8e8e8] hover:bg-[rgba(79,140,255,0.5)]" title="Drag to resize" />
      </div>

      {dragOver && (
        <div className="fixed inset-0 z-100 flex items-center justify-center text-[26px] bg-[rgba(20,22,26,0.8)] border-4 border-dashed border-accent pointer-events-none">
          Drop PDF to open
        </div>
      )}

      {snap.confirmPdfName && (
        <div className="fixed inset-0 z-105 flex items-center justify-center bg-black/50">
          <div id="sessionConfirm" className="bg-panel border border-borderapp rounded-xl p-5 max-w-100 shadow-2xl">
            <div className="text-fgapp font-semibold mb-2">Load this reading session?</div>
            <div className="text-dim text-[12.5px] leading-relaxed mb-4">
              It replaces your current reading history and position for this
              document. (Unsaved history is lost.)
            </div>
            <div className="flex justify-end gap-2">
              <button
                id="btnSessionCancel"
                className="px-3 py-1.5 rounded-md text-fgapp hover:bg-hoverrow cursor-pointer"
                onClick={() => controller.cancelSessionLoad()}
              >
                Cancel
              </button>
              <button
                id="btnSessionReplace"
                className="px-3 py-1.5 rounded-md bg-accent text-white hover:brightness-110 cursor-pointer"
                onClick={() => controller.applyConfirmedSession()}
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}

      {snap.toast && (
        <div
          key={snap.toast.id}
          id="toast"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[#111] text-[#eee] px-4 py-2 rounded-lg z-110 opacity-95"
        >
          {snap.toast.msg}
        </div>
      )}
    </div>
  );
}
