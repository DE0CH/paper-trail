// Small stroke-based inline SVG icons (16px grid), replacing the unicode
// glyphs that rendered at inconsistent sizes/baselines across platforms.

function Svg({ d, size = 16 }: { d: string[]; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}

/** Whole sidebar (panel with a left column). */
export const IconSidebar = () => (
  <Svg d={['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M9 3v18']} />
);

/** Outline / pages panel (table of contents). */
export const IconToc = () => (
  <Svg d={['M4 6h.01', 'M9 6h11', 'M4 12h.01', 'M9 12h11', 'M4 18h.01', 'M9 18h11']} />
);

export const IconUndo = () => (
  <Svg d={['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11']} />
);

export const IconRedo = () => (
  <Svg d={['m15 14 5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13']} />
);

export const IconBack = () => (
  <Svg d={['M19 12H5', 'm12 19-7-7 7-7']} />
);

export const IconForward = () => (
  <Svg d={['M5 12h14', 'm12 5 7 7-7 7']} />
);

/** Replace / swap the PDF. */
export const IconSwap = () => (
  <Svg d={['m16 3 4 4-4 4', 'M20 7H4', 'm8 21-4-4 4-4', 'M4 17h16']} />
);

/** Re-anchor an entry to the current position (crosshair). */
export const IconAnchor = ({ size = 13 }: { size?: number }) => (
  <Svg size={size} d={['M12 2v4', 'M12 18v4', 'M2 12h4', 'M18 12h4', 'M12 12h.01']} />
);

export const IconClose = ({ size = 12 }: { size?: number }) => (
  <Svg size={size} d={['M18 6 6 18', 'm6 6 12 12']} />
);

export const IconPrev = () => <Svg size={14} d={['m18 15-6-6-6 6']} />;
export const IconNext = () => <Svg size={14} d={['m6 9 6 6 6-6']} />;

/** Expand/collapse chevron (rotate with CSS for the open state). */
export const IconChevron = ({ size = 10 }: { size?: number }) => (
  <Svg size={size} d={['m9 18 6-6-6-6']} />
);

export const IconPlus = () => <Svg size={15} d={['M5 12h14', 'M12 5v14']} />;

/** Clear history (trash can). */
export const IconTrash = () => (
  <Svg size={13} d={[
    'M3 6h18',
    'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    'M10 11v6', 'M14 11v6',
  ]} />
);

/** GitHub mark (filled). */
export const IconGitHub = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);

/** Expand all outline sections (chevrons pointing apart). */
export const IconExpandAll = () => (
  <Svg size={14} d={['m7 15 5 5 5-5', 'm7 9 5-5 5 5']} />
);

/** Collapse all outline sections (chevrons pointing together). */
export const IconCollapseAll = () => (
  <Svg size={14} d={['m7 20 5-5 5 5', 'm7 4 5 5 5-5']} />
);

/** Duplicate (two overlapping squares). */
export const IconCopy = ({ size = 12 }: { size?: number }) => (
  <Svg size={size} d={[
    'M8 8h12v12H8z',
    'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2',
  ]} />
);

/** Rename (pencil). */
export const IconEdit = ({ size = 11 }: { size?: number }) => (
  <Svg size={size} d={[
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
  ]} />
);
