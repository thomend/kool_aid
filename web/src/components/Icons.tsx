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

export const BookIcon = () => (
  <svg {...base}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5zM20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" />
  </svg>
);

export const WalkIcon = () => (
  <svg {...base} width={20} height={20} strokeWidth={2.2}>
    <circle cx="13" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <path d="M9 21l2.5-6.5L14 17v4M7 12l2.5-4.5L13 8l2.5 3.5L18 12M11.5 14.5L12.5 8" />
  </svg>
);

// Heat-sensitivity profiles: someone running, walking, and walking with a cane

export const RunIcon = () => (
  <svg {...base} width={20} height={20} strokeWidth={2.2}>
    <circle cx="15.5" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <path d="M6 10.5l3-3h4.5l3 4 3 .5M13.5 7.5L10.5 14l4 3-1 4.5M10.5 14l-2.5 4.5H4" />
  </svg>
);

export const CaneIcon = () => (
  <svg {...base} width={20} height={20} strokeWidth={2.2}>
    <circle cx="10" cy="4" r="1.6" fill="currentColor" stroke="none" />
    <path d="M11 8c-1.5 2-1.5 4-1 6.5M10 14.5L8 21M10 14.5l2.5 3V21M10.5 9.5l4.5 3M15 12.5c0-1.5 1.5-1.8 2-1M15 12.5V21" />
  </svg>
);
