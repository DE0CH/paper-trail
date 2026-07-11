// The find bar: a floating overlay summoned with mod+F, like a browser's.
// It floats over the page so the toolbar never shifts.

import { useRef, type RefObject } from 'react';
import { controller, type Snapshot } from '../core/controller';
import { IconClose, IconNext, IconPrev } from './icons';

const iconBtn = 'inline-flex items-center justify-center w-7 h-7 rounded text-dim hover:text-fgapp hover:bg-hoverrow cursor-pointer';

export default function SearchBar({ snap, searchRef, open, onClose }: {
  snap: Snapshot;
  searchRef: RefObject<HTMLInputElement | null>;
  open: boolean;
  onClose: () => void;
}) {
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  if (!open) return null;

  const close = () => {
    if (searchRef.current) searchRef.current.value = '';
    void controller.runSearch('', { jump: false });
    onClose();
  };

  return (
    <div
      id="searchBar"
      className="absolute top-11 right-4 z-40 flex items-center gap-1 bg-panel border border-borderapp rounded-lg shadow-xl px-2 py-1.5"
    >
      <input
        id="searchInput"
        ref={searchRef}
        className="bg-inputbg text-fgapp border border-borderapp rounded-md px-2 py-1 outline-none focus:border-accent w-52"
        type="text"
        placeholder="Search"
        onChange={(e) => {
          clearTimeout(debounce.current);
          const q = e.target.value.trim();
          debounce.current = setTimeout(() => void controller.runSearch(q), 350);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void controller.gotoMatch(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            close();
          }
        }}
      />
      <span id="searchCount" className="text-dim min-w-13 text-center text-[12px]">
        {snap.searchCount}
      </span>
      <button className={iconBtn} title="Previous match" onClick={() => void controller.gotoMatch(-1)}>
        <IconPrev />
      </button>
      <button className={iconBtn} title="Next match" onClick={() => void controller.gotoMatch(1)}>
        <IconNext />
      </button>
      <button className={iconBtn} title="Close search" onClick={close}>
        <IconClose />
      </button>
    </div>
  );
}
