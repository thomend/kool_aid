// Small stroke icons in the style of SF Symbols.

const base = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const PlusIcon = () => (
  <svg {...base}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const MinusIcon = () => (
  <svg {...base}>
    <path d="M5 12h14" />
  </svg>
);

export const RecenterIcon = () => (
  <svg {...base}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
    <circle cx="12" cy="12" r="2.5" />
  </svg>
);

export const SunIcon = () => (
  <svg {...base}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);

export const MoonIcon = () => (
  <svg {...base}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

export const CloseIcon = () => (
  <svg {...base} width={14} height={14} strokeWidth={2.5}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const ChevronIcon = () => (
  <svg {...base} width={14} height={14} strokeWidth={2.5}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const WalkIcon = () => (
  <svg {...base} width={20} height={20} strokeWidth={2.2}>
    <circle cx="13" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <path d="M9 21l2.5-6.5L14 17v4M7 12l2.5-4.5L13 8l2.5 3.5L18 12M11.5 14.5L12.5 8" />
  </svg>
);
