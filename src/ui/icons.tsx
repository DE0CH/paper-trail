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

/** Rename (pencil). */
export const IconEdit = ({ size = 11 }: { size?: number }) => (
  <Svg size={size} d={[
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
  ]} />
);
