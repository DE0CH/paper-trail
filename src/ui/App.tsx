import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { controller } from '../core/controller';
import { IconClose } from './icons';
import { loadUI, saveUI } from '../core/store';
import Toolbar from './Toolbar';
import SearchBar from './SearchBar';
import Sidebar from './Sidebar';
import ShortcutHelp from './ShortcutHelp';
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [widths, setWidths] = useState(initialWidths);
  const [dragOver, setDragOver] = useState(false);
  const [navOpen, setNavOpen] = useState(() => loadUI().navOpen ?? true);
  const [navTab, setNavTab] = useState<'outline' | 'pages'>(() => loadUI().navTab ?? 'outline');

  // The search bar exists only while searching; opening focuses it once
  // it is in the DOM. mod+F toggles: pressing it again puts the bar away.
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  const closeSearch = () => {
    if (searchRef.current) searchRef.current.value = '';
    void controller.runSearch('', { jump: false });
    setSearchOpen(false);
  };
  const openSearch = () => {
    setSearchOpen(true);
    searchRef.current?.focus();
    searchRef.current?.select();
  };
  const toggleSearch = () => {
    if (searchOpenRef.current) closeSearch();
    else openSearch();
  };
  useEffect(() => {
    if (searchOpen) {
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  }, [searchOpen]);

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

  const [helpOpen, setHelpOpen] = useState(false);
  const toggleHelp = () => setHelpOpen((v) => !v);

  // Global keyboard shortcuts. Every action needs a modifier — this is a
  // normal app, not a modal editor; plain typing must never trigger
  // anything. (Escape only dismisses.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        setHelpOpen(false);
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      const editing = tag === 'INPUT' || tag === 'TEXTAREA';
      if (!mod && !editing && (e.key === '?' || (e.key === '/' && e.shiftKey))) {
        e.preventDefault();
        toggleHelp();
        return;
      }
      if (!mod && e.altKey) {
        if (e.key === 'ArrowLeft') { e.preventDefault(); controller.goBack(); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); controller.goForward(); }
        else if (e.code === 'BracketLeft') { e.preventDefault(); controller.stackCycle(-1); }
        else if (e.code === 'BracketRight') { e.preventDefault(); controller.stackCycle(1); }
        else if (e.shiftKey && e.code === 'KeyD') { e.preventDefault(); controller.stackDuplicateActive(); }
        return;
      }
      if (!mod) return;
      switch (e.key.toLowerCase()) {
        case 'f': e.preventDefault(); toggleSearch(); break;
        case 's': e.preventDefault(); controller.saveProgressSafe(); break;
        case 'z':
          if (editing) return; // text fields keep their native undo
          e.preventDefault();
          if (e.shiftKey) controller.redoHist(); else controller.undoHist();
          break;
        case 'd': e.preventDefault(); controller.markPosition(e.shiftKey); break;
        case 'g':
          // mod+G: reachable left-handed, and unlike the E variants it
          // actually reaches the page in browsers.
          e.preventDefault();
          controller.reanchorCurrent();
          break;
        case 'b':
          e.preventDefault();
          if (e.shiftKey) toggleNav(); else setSidebarVisible((v) => !v);
          break;
        case 'o':
          e.preventDefault();
          if (e.shiftKey) void controller.requestLoadSession();
          else void controller.pickFile();
          break;
        case '[': e.preventDefault(); controller.goBack(); break;
        case ']': e.preventDefault(); controller.goForward(); break;
        case '=': case '+': e.preventDefault(); controller.zoomIn(); break;
        case '-': e.preventDefault(); controller.zoomOut(); break;
        case '0': e.preventDefault(); controller.fitWidth(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Desktop shell integration: inset traffic lights and OS file opens
  // (Open With…, Dock-icon drops, recent documents, File > Open).
  useEffect(() => {
    if (!window.ptDesktop) return;
    if (window.ptDesktop.platform === 'darwin') document.body.classList.add('desktopMac');
    if (window.ptDesktop.platform === 'win32') document.body.classList.add('desktopWin');
    window.ptDesktop.onOpenFile(({ name, data }) => {
      void controller.openFile(new File([data], name));
    });
  }, []);

  // The native close button's dot mirrors unsaved session changes.
  useEffect(() => {
    window.ptDesktop?.setDocumentEdited?.(snap.save === 'dirty');
  }, [snap.save]);

  // Native right-click menus (desktop): classify what was clicked, let the
  // shell pop a native menu, then run the chosen action. Text fields and
  // selections are NOT intercepted — electron-context-menu shows the full
  // native edit menu (spell-check, Look Up, …) for those.
  useEffect(() => {
    const desktop = window.ptDesktop;
    if (!desktop?.showContextMenu) return;
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea')) return;
      if ((window.getSelection()?.toString() ?? '').trim()) return;
      const snapNow = controller.getSnapshot();

      const link = t.closest<HTMLElement>('.pdfLink');
      const hist = t.closest<HTMLElement>('.histItem');
      const stack = t.closest<HTMLElement>('.stackRow');
      const viewer = t.closest<HTMLElement>('#viewerContainer');

      const run = (p: Promise<string | null>, act: (id: string) => void) => {
        e.preventDefault();
        void p.then((id) => { if (id) act(id); });
      };

      if (link) {
        run(desktop.showContextMenu({ type: 'link' }), (id) => {
          link.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, metaKey: id === 'branch',
          }));
        });
      } else if (hist) {
        const idx = Number(hist.dataset.idx);
        run(desktop.showContextMenu({
          type: 'histEntry', current: idx === snapNow.activeIndex,
        }), (id) => {
          if (id === 'jump') controller.histEntryClick(idx);
          else if (id === 'rename') hist.querySelector('.lbl')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          else if (id === 'reanchor') controller.entrySetPos(idx);
        });
      } else if (stack) {
        const sid = Number(stack.dataset.id);
        run(desktop.showContextMenu({
          type: 'stack',
          active: sid === snapNow.activeStackId,
          closable: snapNow.stacks.length > 1,
        }), (id) => {
          if (id === 'switch') controller.stackSwitch(sid);
          else if (id === 'rename') stack.querySelector('.name')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          else if (id === 'duplicate') controller.stackDuplicate(sid);
          else if (id === 'close') controller.stackClose(sid);
        });
      } else if (viewer && snapNow.docOpen) {
        run(desktop.showContextMenu({
          type: 'viewer', canBack: snapNow.canBack, canForward: snapNow.canForward,
        }), (id) => {
          if (id === 'back') controller.goBack();
          else if (id === 'forward') controller.goForward();
          else if (id === 'mark') controller.markPosition();
          else if (id === 'zoom-in') controller.zoomIn();
          else if (id === 'zoom-out') controller.zoomOut();
          else if (id === 'fit') controller.fitWidth();
        });
      } else {
        // Anything else (toolbar, panel chrome, welcome screen) has no
        // meaningful actions: no menu at all beats a stray "Select All".
        e.preventDefault();
      }
    };
    window.addEventListener('contextmenu', onCtx);
    return () => window.removeEventListener('contextmenu', onCtx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Native menu actions when running inside the Electron desktop shell.
  useEffect(() => {
    window.ptDesktop?.onMenu((action, payload) => {
      switch (action) {
        case 'open': void controller.pickFile(); break;
        case 'save': controller.saveProgressSafe(); break;
        case 'load-session': void controller.requestLoadSession(); break;
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
          toggleSearch();
          break;
        case 'search-selection':
          if (payload) {
            setSearchOpen(true);
            queueMicrotask(() => {
              if (searchRef.current) {
                searchRef.current.value = payload;
                searchRef.current.focus();
              }
              void controller.runSearch(payload);
            });
          }
          break;
        case 'toggle-sidebar': setSidebarVisible((v) => !v); break;
        case 'toggle-nav': toggleNav(); break;
        case 'mark': controller.markPosition(); break;
        case 'mark-branch': controller.markPosition(true); break;
        case 'reanchor': controller.reanchorCurrent(); break;
        case 'clear-history': controller.clearHistory(); break;
        case 'help': toggleHelp(); break;
        case 'trail-prev': controller.stackCycle(-1); break;
        case 'trail-next': controller.stackCycle(1); break;
        case 'trail-duplicate': controller.stackDuplicateActive(); break;
        case 'updated':
          controller.showToast(
            `Paper Trail was updated to ${payload ?? 'a new version'}`,
            8000,
          );
          break;
        default: break;
      }
    });
  }, []);

  // Drag & drop. With a document already open, dropping a PDF is
  // deliberately a no-op (open another window for another paper) — but
  // dropping a session file still loads it.
  useEffect(() => {
    let depth = 0;
    const pdfOnlyDrag = (dt: DataTransfer) => {
      const items = [...dt.items].filter((i) => i.kind === 'file');
      return items.length > 0 && items.every((i) => i.type === 'application/pdf');
    };
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      depth++;
      setDragOver(!(controller.getSnapshot().docOpen && pdfOnlyDrag(e.dataTransfer)));
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
      if (!e.dataTransfer) return;
      if (controller.getSnapshot().docOpen) {
        const session = [...e.dataTransfer.files].find((f) => /\.ptl$/i.test(f.name));
        if (session) void controller.openFile(session);
        return;
      }
      void controller.openDropped(e.dataTransfer);
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
        onToggleSidebar={() => setSidebarVisible((v) => !v)}
        navOpen={navOpen}
        onToggleNav={toggleNav}
      />
      <SearchBar
        snap={snap}
        searchRef={searchRef}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
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
        <div className="previewScroll absolute inset-0 top-2 bottom-2 overflow-auto">
          <div className="previewContent" />
        </div>
        <div className="previewPage absolute right-1.5 bottom-3 text-[11px] text-[#555] bg-white/85 px-1.5 rounded z-10">p.</div>
        <div className="previewResizeTop absolute left-0 right-0 top-0 h-2 cursor-ns-resize bg-[#e8e8e8] hover:bg-[rgba(79,140,255,0.5)]" title="Drag to resize" />
        <div className="previewResize absolute left-0 right-0 bottom-0 h-2 cursor-ns-resize bg-[#e8e8e8] hover:bg-[rgba(79,140,255,0.5)]" title="Drag to resize" />
      </div>

      {dragOver && (
        <div className="fixed inset-0 z-100 flex items-center justify-center text-[26px] bg-[rgba(20,22,26,0.8)] border-4 border-dashed border-accent pointer-events-none">
          {snap.docOpen ? 'Drop a session file to load it' : 'Drop a PDF or session file to open'}
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

      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />

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
