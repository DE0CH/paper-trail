import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { controller } from '../core/controller';
import { loadUI, saveUI } from '../core/store';
import Toolbar from './Toolbar';
import Sidebar from './Sidebar';
import Welcome from './Welcome';

// Minimum widths that keep every panel usable.
const STACKS_MIN = 80;
const SIDECOL_MIN = 150;
const VIEWER_MIN = 260;

const clampW = (v: number, min: number, max: number) =>
  Math.min(Math.max(min, max), Math.max(min, v));

function initialWidths() {
  const ui = loadUI();
  const sidebar = clampW(
    ui.sidebarW ?? 440,
    STACKS_MIN + SIDECOL_MIN,
    Math.max(320, window.innerWidth - VIEWER_MIN),
  );
  const stacks = clampW(ui.stacksW ?? 150, STACKS_MIN, sidebar - SIDECOL_MIN);
  return { stacks, sidebar };
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
        case 'o': void controller.pickFile(); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Native menu actions when running inside the Electron desktop shell.
  useEffect(() => {
    window.psrDesktop?.onMenu((action) => {
      switch (action) {
        case 'open': void controller.pickFile(); break;
        case 'save': controller.saveProgressSafe(); break;
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
        case 'toggle-sidebar': setSidebarVisible((v) => !v); break;
        case 'clear-history': controller.clearHistory(); break;
        case 'help':
          controller.showToast(
            'Backspace: back \u00b7 Shift+Backspace: forward \u00b7 Cmd+click link: fork \u00b7 /: search \u00b7 Cmd+S: save progress',
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

  // Panel resizing (both dividers), with mutual constraints.
  const startResize = (which: 'stacks' | 'sidebar', e: React.PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('bg-[rgba(79,140,255,0.35)]');
    document.body.classList.add('resizing');
    const startX = e.clientX;
    const start = { ...widths };
    const bounds = which === 'stacks'
      ? { min: STACKS_MIN, max: start.sidebar - SIDECOL_MIN }
      : { min: start.stacks + SIDECOL_MIN, max: Math.max(320, window.innerWidth - VIEWER_MIN) };
    const move = (ev: PointerEvent) => {
      const w = clampW(
        (which === 'stacks' ? start.stacks : start.sidebar) + ev.clientX - startX,
        bounds.min,
        bounds.max,
      );
      setWidths((prev) => (which === 'stacks'
        ? { ...prev, stacks: w }
        : { ...prev, sidebar: w }));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.classList.remove('bg-[rgba(79,140,255,0.35)]');
      document.body.classList.remove('resizing');
      setWidths((prev) => {
        saveUI({ stacksW: Math.round(prev.stacks), sidebarW: Math.round(prev.sidebar) });
        return prev;
      });
      controller.refitIfNeeded();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  };

  return (
    <div className="flex flex-col h-full">
      <Toolbar snap={snap} searchRef={searchRef} onToggleSidebar={() => setSidebarVisible((v) => !v)} />
      <div className="flex flex-1 min-h-0">
        {sidebarVisible && (
          <Sidebar snap={snap} widths={widths} onStartResize={startResize} />
        )}
        <div
          ref={containerRef}
          id="viewerContainer"
          tabIndex={0}
          className="relative flex-1 overflow-auto outline-none"
        >
          <div ref={viewerRef} id="viewer" className="pt-4 pb-[60vh]" />
          <Welcome snap={snap} />
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
