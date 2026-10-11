/** Line icons, 24×24, drawn with currentColor so they follow the text. */
const PATHS = {
  sun: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0-5v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8',
  shade: 'M12 3a8 8 0 0 0-8 8h16a8 8 0 0 0-8-8Zm0 8v8a2 2 0 0 0 4 0',
  tree: 'M12 22v-6m0 0c-4 0-7-2.5-7-6a7 7 0 0 1 14 0c0 3.5-3 6-7 6Z',
  walk: 'M13 4.5a1.5 1.5 0 1 0 0-.01M9.5 21l2-6 2.5 2.5V21M8 12l1.5-4 3.5-1 2.5 3.5 2.5 1M11 8.5 9.5 13l3 3',
  train: 'M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Zm-3 8h16M8 21l2-4m6 4-2-4M8 14h.01M16 14h.01',
  bus: 'M6 3h12a2 2 0 0 1 2 2v12H4V5a2 2 0 0 1 2-2Zm-2 9h16M7 20v-3m10 3v-3M7.5 15h.01m9 0h.01M4 7h16',
  stairs: 'M3 21h5v-5h5v-5h5V6h3',
  elevator: 'M5 3h14v18H5zM9 9l3-3 3 3M9 15l3 3 3-3',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
  pin: 'M12 22s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12Zm0-9.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  locate: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v3m0 14v3M2 12h3m14 0h3',
  swap: 'M7 4v14m0 0-3-3m3 3 3-3M17 20V6m0 0 3 3m-3-3-3 3',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2.2-1.3L14.4 3h-4l-.4 2.6a7.5 7.5 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2.2 1.3l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z',
  speaker: 'M4 9v6h4l5 4V5L8 9H4Zm12.5-1a5 5 0 0 1 0 8m2.5-10.5a8.5 8.5 0 0 1 0 13',
  stop: 'M7 7h10v10H7z',
  share: 'M12 3v12m0-12-4 4m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  print: 'M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M7 14h10v7H7z',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  back: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.3-4.3',
  snow: 'M12 2v20M4.9 7l14.2 10M4.9 17 19.1 7M9 4l3 3 3-3M9 20l3-3 3 3',
  rain: 'M12 3a8 8 0 0 0-8 8h16a8 8 0 0 0-8-8Zm0 8v8a2 2 0 0 1-4 0',
  drop: 'M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11Z',
  toilet: 'M7 3h3v6H7zM5 9h14a7 7 0 0 1-7 7h0a7 7 0 0 1-7-7Zm4 7-1 5h8l-1-5',
  bench: 'M4 10h16M4 14h16M6 14v5m12-5v5M5 6h14v4H5z',
  store: 'M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6',
  building: 'M5 21V5l7-3 7 3v16M9 9h.01M15 9h.01M9 13h.01M15 13h.01M10 21v-4h4v4',
  cool: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-4 9h8m-4-4v8m-2.8-5.2 5.6 2.4m0-2.4-5.6 2.4',
  alert: 'M12 3 2 20h20L12 3Zm0 6v5m0 3h.01',
  check: 'M5 12l5 5 9-10',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 5h.01M11 11h1v6h1',
  close: 'M6 6l12 12M18 6 6 18',
  arrowUp: 'M12 19V5m0 0-6 6m6-6 6 6',
  turnLeft: 'M14 20v-7a3 3 0 0 0-3-3H5m0 0 4-4m-4 4 4 4',
  turnRight: 'M10 20v-7a3 3 0 0 1 3-3h6m0 0-4-4m4 4-4 4',
  home: 'M3 11 12 3l9 8M5 9.5V21h14V9.5',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  hospital: 'M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16M3 21h18M12 7v6m-3-3h6',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4m8-4v4',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z',
  line: 'M4 18.5c0 .8.7 1.5 1.5 1.5h13c.8 0 1.5-.7 1.5-1.5v-13C20 4.7 19.3 4 18.5 4h-13C4.7 4 4 4.7 4 5.5v13ZM8 9.5c0-.3 1.8-1.5 4-1.5s4 1.2 4 2.8c0 1.7-2 3.2-4 4.2v-1.2c-2.2 0-4-1.5-4-3.2V9.5Z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 24, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
