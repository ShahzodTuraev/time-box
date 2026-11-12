"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// Chromium's install prompt event (not yet in the TS DOM lib).
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface Window {
    // Exposed by the Electron preload script; absent in the browser.
    timebox?: { setWidget: (on: boolean) => void };
    // Document Picture-in-Picture (Chromium): floating always-on-top window.
    documentPictureInPicture?: {
      requestWindow(options?: {
        width?: number;
        height?: number;
      }): Promise<Window>;
    };
  }
}

// Copy this document's styles into another document (the PiP window).
function copyStyles(target: Document) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      const style = target.createElement("style");
      style.textContent = css;
      target.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = target.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
}

function pad(n: number, len = 2) {
  return String(n).padStart(len, "0");
}

type Tracker = {
  id: string;
  label: string;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  color: number; // stable palette slot — color follows the entity
};

// Categorical slots 2-8 of the validated reference palette (slot 1 blue is the
// day cycle). Track = lighter step of the same hue. Values live in globals.css.
const RING_COLORS = [
  { fill: "stroke-(--series-1)", track: "stroke-(--series-1-track)", disc: "fill-(--series-1-track)", text: "text-(--series-1)" },
  { fill: "stroke-(--series-2)", track: "stroke-(--series-2-track)", disc: "fill-(--series-2-track)", text: "text-(--series-2)" },
  { fill: "stroke-(--series-3)", track: "stroke-(--series-3-track)", disc: "fill-(--series-3-track)", text: "text-(--series-3)" },
  { fill: "stroke-(--series-4)", track: "stroke-(--series-4-track)", disc: "fill-(--series-4-track)", text: "text-(--series-4)" },
  { fill: "stroke-(--series-5)", track: "stroke-(--series-5-track)", disc: "fill-(--series-5-track)", text: "text-(--series-5)" },
  { fill: "stroke-(--series-6)", track: "stroke-(--series-6-track)", disc: "fill-(--series-6-track)", text: "text-(--series-6)" },
  { fill: "stroke-(--series-7)", track: "stroke-(--series-7-track)", disc: "fill-(--series-7-track)", text: "text-(--series-7)" },
];

const YEAR_COLOR = {
  fill: "stroke-(--year)",
  track: "stroke-(--year-track)",
  text: "text-(--year)",
};
const MONTH_COLOR = {
  fill: "stroke-(--month)",
  track: "stroke-(--month-track)",
  text: "text-(--month)",
};
const DAY_COLOR = {
  fill: "stroke-(--day)",
  track: "stroke-(--day-track)",
  text: "text-(--day)",
};

const DEFAULT_TRACKERS: Tracker[] = [
  { id: "work", label: "Working hours", start: "09:00", end: "18:00", color: 0 },
  { id: "break", label: "Break", start: "12:00", end: "13:00", color: 1 },
];

const STORAGE_KEY = "time-box-trackers";
const HIDDEN_CYCLES_KEY = "time-box-hidden-cycles";
const ORDER_KEY = "time-box-order";

function minutesOf(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function fmtDur(min: number) {
  const whole = Math.ceil(min);
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m`;
}

// Progress is monotonic over the day: 0% before start, rising while active,
// then pinned at 100% "Done" — it never falls back once the time has passed.
function trackerState(tracker: Tracker, nowMin: number) {
  const startM = minutesOf(tracker.start);
  const endM = minutesOf(tracker.end);

  if (endM > startM) {
    if (nowMin < startM)
      return {
        pct: 0,
        status: `Starts in ${fmtDur(startM - nowMin)}`,
        active: false,
      };
    if (nowMin >= endM) return { pct: 100, status: "Done", active: false };
    return {
      pct: ((nowMin - startM) / (endM - startM)) * 100,
      status: `${fmtDur(endM - nowMin)} left`,
      active: true,
    };
  }

  // Range crosses midnight (e.g. 22:00 – 06:00).
  const duration = endM - startM + 1440;
  if (nowMin >= startM)
    return {
      pct: ((nowMin - startM) / duration) * 100,
      status: `${fmtDur(startM + duration - nowMin)} left`,
      active: true,
    };
  if (nowMin < endM)
    return {
      pct: ((nowMin + 1440 - startM) / duration) * 100,
      status: `${fmtDur(endM - nowMin)} left`,
      active: true,
    };
  // Daytime gap after this morning's end: already finished — stays at 100%.
  return { pct: 100, status: "Done", active: false };
}

// Status line under each ring. The remaining duration is the number people
// glance for, so it sits in a pill tinted with the ring's own track color;
// other statuses ("Starts in…", "Done") stay quiet muted text.
function StatusText({
  status,
  color,
}: {
  status: string;
  color: { text: string };
}) {
  if (status.endsWith(" left")) {
    return (
      <span className="mt-0.5 inline-flex items-baseline gap-1 self-center">
        <span className={`text-xs font-semibold tabular-nums ${color.text}`}>
          {status.slice(0, -" left".length)}
        </span>
        <span className="text-[10px] text-(--ink-2)">left</span>
      </span>
    );
  }
  return <span className="text-[11px] text-(--muted)">{status}</span>;
}

function Ring({
  pct,
  color,
  label,
  center,
  sizeClass = "h-20 w-20",
  disc,
}: {
  pct: number;
  color: { fill: string; track: string };
  label: string;
  center?: React.ReactNode;
  sizeClass?: string;
  // Fill class for a soft disc inside the ring (used by finished timers).
  disc?: string;
}) {
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <div
      className={`relative ${sizeClass}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={`${label} complete`}
    >
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        {disc && <circle cx="50" cy="50" r="33" className={disc} />}
        <circle
          cx="50"
          cy="50"
          r={r}
          fill="none"
          strokeWidth="10"
          className={color.track}
        />
        {pct > 0 && (
          <circle
            cx="50"
            cy="50"
            r={r}
            fill="none"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${(Math.min(pct, 100) / 100) * c} ${c}`}
            className={color.fill}
          />
        )}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-semibold tabular-nums text-(--ink)">
        {center ?? (
          <span className="text-lg">
            {Math.round(pct)}
            <span className="text-xs font-normal text-(--muted)">%</span>
          </span>
        )}
      </span>
    </div>
  );
}

// Illustrated "how to use" guide, shown from the button under the card.
function HelpModal({ onClose }: { onClose: () => void }) {
  const figCls =
    "flex items-center justify-center rounded-xl border border-(--edge) bg-(--page) p-3";
  const steps: { title: string; body: string; figure: React.ReactNode }[] = [
    {
      title: "Read the clock",
      body: "The big clock is the heart of the Time Box. Click the \":ss\" seconds to hide them; click the clock again to bring them back.",
      figure: (
        <svg viewBox="0 0 280 70" className="h-20 w-full">
          <text
            x="125"
            y="45"
            textAnchor="middle"
            fontFamily="ui-monospace, monospace"
            fontSize="30"
            fontWeight="600"
            fill="var(--ink)"
          >
            12:34
            <tspan fill="var(--accent)">:56</tspan>
          </text>
          <path
            d="M196 48 l0 14 l4 -4 l3 6 l4 -2 l-3 -6 l6 -1 z"
            fill="var(--ink)"
            stroke="var(--surface)"
            strokeWidth="1"
          />
        </svg>
      ),
    },
    {
      title: "Year, Month and Day rings",
      body: "The three colorful rings show how much of the year (teal), month (magenta) and day (blue) has already passed, with the time left underneath.",
      figure: (
        <svg viewBox="0 0 280 80" className="h-24 w-full">
          {(
            [
              { x: 70, color: "--year", track: "--year-track", dash: 86 },
              { x: 140, color: "--month", track: "--month-track", dash: 35 },
              { x: 210, color: "--day", track: "--day-track", dash: 60 },
            ] as const
          ).map((r) => (
            <g key={r.x}>
              <circle
                cx={r.x}
                cy="36"
                r="22"
                fill="none"
                stroke={`var(${r.track})`}
                strokeWidth="6"
              />
              <circle
                cx={r.x}
                cy="36"
                r="22"
                fill="none"
                stroke={`var(${r.color})`}
                strokeWidth="6"
                strokeLinecap="round"
                pathLength={100}
                strokeDasharray={`${r.dash} 100`}
                transform={`rotate(-90 ${r.x} 36)`}
              />
            </g>
          ))}
          <text x="70" y="74" textAnchor="middle" fontSize="10" fill="var(--muted)">
            Year
          </text>
          <text x="140" y="74" textAnchor="middle" fontSize="10" fill="var(--muted)">
            Month
          </text>
          <text x="210" y="74" textAnchor="middle" fontSize="10" fill="var(--muted)">
            Day
          </text>
        </svg>
      ),
    },
    {
      title: "Hide and restore rings",
      body: "Hover a ring and click the small × in its corner to put it away. The circular refresh button at the top brings every hidden ring back.",
      figure: (
        <svg viewBox="0 0 280 70" className="h-20 w-full">
          <circle cx="80" cy="36" r="20" fill="none" stroke="var(--day-track)" strokeWidth="6" />
          <circle
            cx="80"
            cy="36"
            r="20"
            fill="none"
            stroke="var(--day)"
            strokeWidth="6"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="60 100"
            transform="rotate(-90 80 36)"
          />
          <text x="104" y="18" fontSize="14" fill="var(--muted)">
            ×
          </text>
          <path d="M130 36 h36 m0 0 l-8 -5 m8 5 l-8 5" stroke="var(--muted)" strokeWidth="1.5" fill="none" />
          <circle cx="205" cy="36" r="14" fill="none" stroke="var(--edge)" strokeWidth="1.5" />
          <path
            d="M211 31 a8 8 0 1 0 1.5 9"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path d="M213 27 l0 5 l-5 0" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      title: "Add your own timers",
      body: "Click the dashed + circle to add a timer with a name, start and end time. Running timers sit next to the rings; finished and upcoming ones move to the row below. Hover and click × to delete one.",
      figure: (
        <svg viewBox="0 0 280 70" className="h-20 w-full">
          <circle
            cx="85"
            cy="36"
            r="20"
            fill="none"
            stroke="var(--axis)"
            strokeWidth="2"
            strokeDasharray="4 4"
          />
          <text x="85" y="43" textAnchor="middle" fontSize="20" fill="var(--muted)">
            +
          </text>
          <path d="M120 36 h32 m0 0 l-8 -5 m8 5 l-8 5" stroke="var(--muted)" strokeWidth="1.5" fill="none" />
          <circle cx="192" cy="36" r="20" fill="none" stroke="var(--series-1-track)" strokeWidth="6" />
          <circle
            cx="192"
            cy="36"
            r="20"
            fill="none"
            stroke="var(--series-1)"
            strokeWidth="6"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="45 100"
            transform="rotate(-90 192 36)"
          />
        </svg>
      ),
    },
    {
      title: "Reorder by dragging",
      body: "Grab any progress box with the mouse and drop it on another one to take its place. The box under the cursor lights up, and a dashed “Move here” slot after the last box drops it at the end.",
      figure: (
        <svg viewBox="0 0 280 70" className="h-20 w-full">
          <circle cx="60" cy="36" r="20" fill="none" stroke="var(--year-track)" strokeWidth="6" />
          <circle
            cx="60"
            cy="36"
            r="20"
            fill="none"
            stroke="var(--year)"
            strokeWidth="6"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray="86 100"
            transform="rotate(-90 60 36)"
          />
          <path
            d="M95 36 h80 m0 0 l-10 -6 m10 6 l-10 6"
            stroke="var(--accent)"
            strokeWidth="2"
            fill="none"
            strokeDasharray="5 4"
          />
          <circle
            cx="215"
            cy="36"
            r="20"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeDasharray="4 4"
          />
          <text x="215" y="41" textAnchor="middle" fontSize="14" fill="var(--accent)">
            →
          </text>
        </svg>
      ),
    },
    {
      title: "Float it as a widget",
      body: "The “Widget” button shrinks the Time Box into a small always-visible card with the rings and clock. “Open in app” installs it as a standalone app.",
      figure: (
        <svg viewBox="0 0 280 70" className="h-20 w-full">
          <rect
            x="55"
            y="14"
            width="170"
            height="44"
            rx="12"
            fill="var(--surface)"
            stroke="var(--edge)"
            strokeWidth="1.5"
          />
          {(
            [
              { x: 78, color: "--year", track: "--year-track", dash: 86 },
              { x: 104, color: "--month", track: "--month-track", dash: 35 },
              { x: 130, color: "--day", track: "--day-track", dash: 60 },
            ] as const
          ).map((r) => (
            <g key={r.x}>
              <circle cx={r.x} cy="36" r="9" fill="none" stroke={`var(${r.track})`} strokeWidth="3" />
              <circle
                cx={r.x}
                cy="36"
                r="9"
                fill="none"
                stroke={`var(${r.color})`}
                strokeWidth="3"
                strokeLinecap="round"
                pathLength={100}
                strokeDasharray={`${r.dash} 100`}
                transform={`rotate(-90 ${r.x} 36)`}
              />
            </g>
          ))}
          <text
            x="152"
            y="42"
            fontFamily="ui-monospace, monospace"
            fontSize="16"
            fontWeight="600"
            fill="var(--ink)"
          >
            12:34
          </text>
        </svg>
      ),
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="How to use Time Box"
    >
      <div
        className="max-h-[85dvh] w-full max-w-lg overflow-y-auto rounded-2xl border border-(--edge) bg-(--surface) p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-[0.3em] text-(--muted)">
            How to use Time Box
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close help"
            className="flex h-7 w-7 items-center justify-center rounded-full text-(--muted) hover:bg-(--wash) hover:text-(--ink)"
          >
            ×
          </button>
        </div>
        <ol className="flex flex-col gap-6">
          {steps.map((step, i) => (
            <li key={step.title} className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-(--ink)">
                <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-(--accent) text-[11px] font-semibold text-white">
                  {i + 1}
                </span>
                {step.title}
              </h3>
              <p className="text-[13px] leading-relaxed text-(--ink-2)">
                {step.body}
              </p>
              <div className={figCls}>{step.figure}</div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default function Home() {
  const [now, setNow] = useState<Date | null>(null);
  const [trackers, setTrackers] = useState<Tracker[]>(DEFAULT_TRACKERS);
  const [formOpen, setFormOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [draft, setDraft] = useState({ label: "", start: "09:00", end: "17:00" });
  const [isApp, setIsApp] = useState(false);
  const [hiddenCycles, setHiddenCycles] = useState<string[]>([]);
  // Display order of all ring cards (cycle names + tracker ids); ids not in
  // the list keep their natural position.
  const [order, setOrder] = useState<string[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  // Card (or end slot) the dragged box is currently hovering over.
  const [overId, setOverId] = useState<string | null>(null);
  const [showSeconds, setShowSeconds] = useState(true);
  const [widgetView, setWidgetView] = useState(false);
  const [canPip, setCanPip] = useState(false);
  const [pipWin, setPipWin] = useState<Window | null>(null);
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(
    null
  );

  useEffect(() => {
    setIsApp(typeof window.timebox !== "undefined");
    setCanPip(typeof window.documentPictureInPicture !== "undefined");
    if (new URLSearchParams(window.location.search).has("widget")) {
      setWidgetView(true);
      // The widget always renders in light mode.
      document.documentElement.dataset.theme = "light";
      // The widget window is frameless and transparent; let the rounded
      // card be the only visible surface.
      document.documentElement.style.backgroundColor = "transparent";
      document.body.style.backgroundColor = "transparent";
    }

    // Storage is written only inside user actions (persist), never from an
    // effect — an effect re-runs on hot reload and lets a stale tab clobber
    // what another tab saved.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setTrackers(JSON.parse(raw));
      const hidden = localStorage.getItem(HIDDEN_CYCLES_KEY);
      if (hidden) setHiddenCycles(JSON.parse(hidden));
      const ord = localStorage.getItem(ORDER_KEY);
      if (ord) setOrder(JSON.parse(ord));
    } catch {
      // storage unavailable — keep defaults
    }

    const onStorage = (e: StorageEvent) => {
      if (e.newValue === null) return;
      try {
        if (e.key === STORAGE_KEY) setTrackers(JSON.parse(e.newValue));
        else if (e.key === HIDDEN_CYCLES_KEY)
          setHiddenCycles(JSON.parse(e.newValue));
        else if (e.key === ORDER_KEY) setOrder(JSON.parse(e.newValue));
      } catch {
        // ignore malformed values from other tabs
      }
    };
    window.addEventListener("storage", onStorage);

    // "Open in app": the browser fires beforeinstallprompt when the site is
    // installable and not yet installed. Defer it to our own button; after
    // installation (appinstalled) the button disappears.
    const onInstallable = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstallEvt(null);
    window.addEventListener("beforeinstallprompt", onInstallable);
    window.addEventListener("appinstalled", onInstalled);

    let frame: number;
    const tick = () => {
      setNow(new Date());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("beforeinstallprompt", onInstallable);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const persistHiddenCycles = (next: string[]) => {
    setHiddenCycles(next);
    try {
      localStorage.setItem(HIDDEN_CYCLES_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable — hidden rings just won't persist
    }
  };

  const persistOrder = (next: string[]) => {
    setOrder(next);
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable — the order just won't persist
    }
  };

  const persist = (next: Tracker[]) => {
    setTrackers(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable — trackers just won't persist
    }
  };

  const addTracker = () => {
    if (draft.start === draft.end) return;
    const used = new Set(trackers.map((t) => t.color));
    let color = 0;
    while (used.has(color) && color < RING_COLORS.length - 1) color++;
    persist([
      ...trackers,
      {
        id: `${Date.now()}`,
        label: draft.label.trim() || "Timer",
        start: draft.start,
        end: draft.end,
        color,
      },
    ]);
    setDraft({ label: "", start: "09:00", end: "17:00" });
    setFormOpen(false);
  };

  let clock = { hh: "--", mm: "--", ss: "--" };
  let dateLine = " ";
  let dayPct = 0;
  let remaining = "";
  let nowMin = 0;
  let yearPct = 0;
  let yearRemaining = "";
  let monthPct = 0;
  let monthRemaining = "";

  if (now) {
    const ms = now.getMilliseconds();
    const s = now.getSeconds();
    const m = now.getMinutes();
    const h = now.getHours();

    clock = {
      hh: pad(h),
      mm: pad(m),
      ss: pad(s),
    };
    dateLine = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const secOfDay = h * 3600 + m * 60 + s + ms / 1000;
    nowMin = secOfDay / 60;
    dayPct = (secOfDay / 86400) * 100;
    const left = 86400 - secOfDay;
    remaining = `${Math.floor(left / 3600)}h ${pad(Math.floor((left % 3600) / 60))}m left`;

    // Year and month cycles — continuous, so leap years and month lengths
    // fall out of the Date math.
    const t = now.getTime();
    const yearStart = new Date(now.getFullYear(), 0, 1).getTime();
    const yearEnd = new Date(now.getFullYear() + 1, 0, 1).getTime();
    yearPct = ((t - yearStart) / (yearEnd - yearStart)) * 100;
    yearRemaining = `${Math.ceil((yearEnd - t) / 86400000)}d left`;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    monthPct = ((t - monthStart) / (monthEnd - monthStart)) * 100;
    monthRemaining = `${Math.ceil((monthEnd - t) / 86400000)}d left`;
  }

  // Clock segments: clicking ":ss" hides the seconds, and clicking the
  // remaining clock brings them back.
  const allShown = showSeconds;
  const showAll = () => {
    setShowSeconds(true);
  };
  const clockDigits = (
    <>
      {clock.hh}:{clock.mm}
      {showSeconds && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            setShowSeconds(false);
          }}
          title="Click to hide seconds"
          className="cursor-pointer"
        >
          :{clock.ss}
        </span>
      )}
    </>
  );

  // Calendar cycle rings, minus the hidden ones, in the user's order.
  const orderIdx = (id: string) => {
    const i = order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const cycles = [
    { id: "Year", pct: yearPct, status: yearRemaining, color: YEAR_COLOR },
    { id: "Month", pct: monthPct, status: monthRemaining, color: MONTH_COLOR },
    { id: "Day", pct: dayPct, status: remaining, color: DAY_COLOR },
  ]
    .filter((c) => !hiddenCycles.includes(c.id))
    .sort((a, b) => orderIdx(a.id) - orderIdx(b.id));

  // Reorder by drag and drop: dropping one ring card on another moves it to
  // that position. The canonical order covers every card (cycles + trackers),
  // so a move survives cards switching between the active and inactive rows.
  const canonicalIds = () =>
    ["Year", "Month", "Day", ...trackers.map((t) => t.id)].sort(
      (a, b) => orderIdx(a) - orderIdx(b)
    );

  const moveItem = (src: string, dst: string) => {
    const ids = canonicalIds();
    const from = ids.indexOf(src);
    const to = ids.indexOf(dst);
    if (from === -1 || to === -1 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, src);
    persistOrder(ids);
  };

  const moveToEnd = (src: string) => {
    const ids = canonicalIds().filter((i) => i !== src);
    ids.push(src);
    persistOrder(ids);
  };

  const endDrag = () => {
    setDragId(null);
    setOverId(null);
  };

  const dragProps = (id: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      setDragId(id);
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragId && dragId !== id) setOverId(id);
    },
    onDragLeave: () => setOverId((cur) => (cur === id ? null : cur)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragId && dragId !== id) moveItem(dragId, id);
      endDrag();
    },
    onDragEnd: endDrag,
  });

  // Shared card styling: the dragged card dims, and the card under the
  // pointer lights up as the drop position.
  const cardCls = (id: string) =>
    `group relative flex cursor-grab flex-col items-center gap-1.5 rounded-2xl text-center transition-all duration-150 active:cursor-grabbing ${
      dragId === id ? "opacity-40" : ""
    } ${
      overId === id && dragId !== id
        ? "scale-105 bg-(--wash) outline-2 outline-dashed outline-offset-4 outline-(--accent)"
        : ""
    }`;

  // Dashed slot after the last card, shown only mid-drag: dropping there
  // moves the card to the end. `small` is the compact widget variant.
  const endDropZone = (slot: string, small = false) =>
    dragId && (
      <div
        key={slot}
        onDragOver={(e) => {
          e.preventDefault();
          setOverId(slot);
        }}
        onDragLeave={() => setOverId((cur) => (cur === slot ? null : cur))}
        onDrop={(e) => {
          e.preventDefault();
          if (dragId) moveToEnd(dragId);
          endDrag();
        }}
        className="flex flex-col items-center gap-1.5 self-start"
      >
        <span
          className={`flex items-center justify-center rounded-full border-2 border-dashed font-light transition-all duration-150 ${
            small ? "h-11 w-11 text-sm" : "h-20 w-20 text-2xl"
          } ${
            overId === slot
              ? "scale-110 animate-pulse border-(--accent) text-(--accent)"
              : "border-(--axis) text-(--muted)"
          }`}
        >
          →
        </span>
        {!small && (
          <span
            className={`text-xs transition-colors ${overId === slot ? "text-(--accent)" : "text-(--muted)"}`}
          >
            Move here
          </span>
        )}
      </div>
    );

  // The compact widget card. Rendered as the whole page in the Electron
  // widget window (with its own window controls), and portaled into the
  // Document PiP window in the browser (PiP has native controls).
  const widgetCard = (showControls: boolean) => (
    <div className="app-drag flex h-dvh w-screen items-center gap-3 rounded-2xl border border-(--edge) bg-(--surface) px-4 font-sans shadow-lg">
      <div className="app-no-drag flex items-center gap-2">
        {cycles.map((c) => (
          <div
            key={c.id}
            {...dragProps(c.id)}
            className={`flex cursor-grab flex-col items-center rounded-xl transition-all duration-150 active:cursor-grabbing ${
              dragId === c.id ? "opacity-40" : ""
            } ${
              overId === c.id && dragId !== c.id
                ? "scale-110 bg-(--wash) outline-2 outline-dashed outline-offset-2 outline-(--accent)"
                : ""
            }`}
          >
            <Ring
              pct={c.pct}
              color={c.color}
              label={c.id}
              sizeClass="h-11 w-11"
              center={
                <span className="text-[10px]">
                  {Math.round(c.pct)}
                  <span className="text-[8px] font-normal text-(--muted)">
                    %
                  </span>
                </span>
              }
            />
            <span className="text-[8px] font-medium text-(--muted)">
              {c.id}
            </span>
          </div>
        ))}
        {endDropZone("end-widget", true)}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[9px] font-semibold uppercase tracking-[0.25em] text-(--muted)">
          Time Box
        </span>
        <p
          onClick={allShown ? undefined : showAll}
          title={allShown ? undefined : "Click to show the hidden digits"}
          className={`app-no-drag mt-0.5 select-none font-mono text-2xl font-semibold leading-none tabular-nums text-(--ink) ${allShown ? "" : "cursor-pointer"}`}
        >
          {clockDigits}
        </p>
        <p className="mt-1 truncate text-[11px] text-(--muted)">
          {remaining} today
        </p>
      </div>
      {showControls && (
        <div className="app-no-drag flex flex-col items-center">
          <button
            type="button"
            onClick={() => window.timebox?.setWidget(false)}
            title="Expand"
            aria-label="Expand to full window"
            className="flex h-6 w-6 items-center justify-center rounded-full text-(--muted) hover:bg-(--wash) hover:text-(--ink)"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            title="Close"
            aria-label="Close Time Box"
            className="flex h-6 w-6 items-center justify-center rounded-full text-(--muted) hover:bg-(--wash) hover:text-(--ink)"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );

  if (widgetView) {
    return widgetCard(true);
  }

  const openWidget = async () => {
    // Electron: swap to the frameless widget window.
    if (window.timebox) {
      window.timebox.setWidget(true);
      return;
    }
    // Browser: toggle a Document Picture-in-Picture window.
    if (pipWin) {
      pipWin.close();
      setPipWin(null);
      return;
    }
    const dpp = window.documentPictureInPicture;
    if (!dpp) return;
    const pip = await dpp.requestWindow({ width: 470, height: 360 });
    copyStyles(pip.document);
    pip.document.title = "Time Box";
    pip.document.documentElement.dataset.theme = "light"; // widget stays light
    pip.document.body.style.margin = "0";
    pip.addEventListener("pagehide", () => setPipWin(null));
    setPipWin(pip);
  };

  // Hand the deferred install prompt to the browser; on accept it installs
  // the PWA and opens it in its own application window. The event is
  // single-use, so drop it either way (if dismissed, the browser fires a
  // fresh one on the next visit).
  const openInApp = async () => {
    if (!installEvt) return;
    setInstallEvt(null);
    await installEvt.prompt();
  };

  const inputCls =
    "rounded-lg border border-(--edge) bg-transparent px-2.5 py-1.5 text-sm text-(--ink) outline-none focus:border-(--accent)";

  const trackerEntries = trackers.map((tracker) => ({
    tracker,
    state: now
      ? trackerState(tracker, nowMin)
      : { pct: 0, status: " ", active: false },
  }));

  const trackerCard = ({
    tracker,
    state,
  }: (typeof trackerEntries)[number]) => {
    const color = RING_COLORS[tracker.color % RING_COLORS.length];
    const done = !state.active && state.pct >= 100;
    return (
      <div
        key={tracker.id}
        {...dragProps(tracker.id)}
        className={cardCls(tracker.id)}
      >
        <button
          type="button"
          onClick={() => persist(trackers.filter((t) => t.id !== tracker.id))}
          aria-label={`Remove ${tracker.label}`}
          className="absolute -top-1 right-0 hidden h-6 w-6 items-center justify-center rounded-full text-(--muted) hover:bg-(--wash) group-hover:flex"
        >
          ×
        </button>
        <Ring
          pct={state.pct}
          color={color}
          label={tracker.label}
          disc={done ? color.disc : undefined}
          center={
            done ? (
              <svg
                width="30"
                height="30"
                viewBox="0 0 24 24"
                fill="none"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={color.fill}
                aria-hidden="true"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : undefined
          }
        />
        <div className="flex flex-col">
          <span className="max-w-24 truncate text-xs font-medium text-(--ink)">
            {tracker.label}
          </span>
          <span className="text-[11px] tabular-nums text-(--ink-2)">
            {tracker.start} – {tracker.end}
          </span>
          <StatusText status={state.status} color={color} />
        </div>
      </div>
    );
  };

  // The Time Box content — on the page it sits in the bordered card; in the
  // floating widget it fills the window flat, with no card frame.
  const mainCard = (flat = false) => (
      <main
        className={
          flat
            ? "flex min-h-dvh w-full flex-col gap-3 bg-(--surface) p-4"
            : "flex w-full max-w-xl flex-col gap-5 rounded-2xl border border-(--edge) bg-(--surface) p-6 shadow-sm sm:p-8"
        }
        suppressHydrationWarning
      >
        {/* Header */}
        <header className="flex items-center justify-between">
          <h1 className="text-xs font-semibold uppercase tracking-[0.3em] text-(--muted)">
            Time Box
          </h1>
          <div className="flex items-center gap-3">
            <p className="text-xs text-(--ink-2)">{dateLine}</p>
            <button
              type="button"
              onClick={() => persistHiddenCycles([])}
              title="Restore the Year, Month and Day rings"
              aria-label="Restore hidden progress rings"
              className="flex h-6 w-6 items-center justify-center rounded-full border border-(--edge) text-(--ink-2) transition-colors hover:border-(--accent) hover:text-(--accent)"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            {installEvt && (
              <button
                type="button"
                onClick={openInApp}
                title="Install and open as a standalone app"
                className="rounded-full border border-(--edge) px-2.5 py-0.5 text-[11px] text-(--ink-2) transition-colors hover:border-(--accent) hover:text-(--accent)"
              >
                Open in app
              </button>
            )}
            {(isApp || canPip) && (
              <button
                type="button"
                onClick={openWidget}
                title="Shrink to a floating widget"
                className="rounded-full border border-(--edge) px-2.5 py-0.5 text-[11px] text-(--ink-2) transition-colors hover:border-(--accent) hover:text-(--accent)"
              >
                {pipWin ? "Close widget" : "Widget"}
              </button>
            )}
          </div>
        </header>

        {/* Clock — hero figure; segments hide on click, clock click restores */}
        <p
          onClick={allShown ? undefined : showAll}
          title={allShown ? undefined : "Click to show the hidden digits"}
          className={`select-none text-center font-mono text-5xl font-semibold tabular-nums text-(--ink) ${allShown ? "" : "cursor-pointer"}`}
        >
          {clockDigits}
        </p>

        <hr className="border-0 border-t border-(--hairline)" />

        {/* Current cycles: year, month, day + timers running right now,
            interleaved in the user's drag-and-drop order */}
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4">
          {[
            ...cycles.map((c) => ({ id: c.id, cycle: c, entry: undefined })),
            ...trackerEntries
              .filter(({ state }) => state.active)
              .map((e) => ({ id: e.tracker.id, cycle: undefined, entry: e })),
          ]
            .sort((a, b) => orderIdx(a.id) - orderIdx(b.id))
            .map((item) =>
              item.cycle ? (
                <div
                  key={item.cycle.id}
                  {...dragProps(item.cycle.id)}
                  className={cardCls(item.cycle.id)}
                >
                  <button
                    type="button"
                    onClick={() =>
                      persistHiddenCycles([...hiddenCycles, item.cycle.id])
                    }
                    aria-label={`Hide ${item.cycle.id} progress`}
                    className="absolute -top-1 right-0 hidden h-6 w-6 items-center justify-center rounded-full text-(--muted) hover:bg-(--wash) group-hover:flex"
                  >
                    ×
                  </button>
                  <Ring
                    pct={item.cycle.pct}
                    color={item.cycle.color}
                    label={item.cycle.id}
                    center={
                      <span className="text-base">
                        {item.cycle.pct.toFixed(1)}
                        <span className="text-xs font-normal text-(--muted)">
                          %
                        </span>
                      </span>
                    }
                  />
                  <div className="flex flex-col">
                    <span className="text-xs font-medium text-(--ink)">
                      {item.cycle.id}
                    </span>
                    <StatusText
                      status={item.cycle.status}
                      color={item.cycle.color}
                    />
                  </div>
                </div>
              ) : (
                trackerCard(item.entry!)
              )
            )}
          {endDropZone("end-current")}
        </div>

        {/* Completed and upcoming timers on their own line */}
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4">
          {trackerEntries
            .filter(({ state }) => !state.active)
            .sort((a, b) => orderIdx(a.tracker.id) - orderIdx(b.tracker.id))
            .map(trackerCard)}
          {endDropZone("end-later")}

          <button
            type="button"
            onClick={() => setFormOpen((v) => !v)}
            className="group flex flex-col items-center gap-1.5 self-start"
          >
            <span className="flex h-20 w-20 items-center justify-center rounded-full border-2 border-dashed border-(--axis) text-2xl font-light text-(--muted) transition-colors group-hover:border-(--accent) group-hover:text-(--accent)">
              {formOpen ? "×" : "+"}
            </span>
            <span className="text-xs text-(--muted)">
              {formOpen ? "Cancel" : "Add timer"}
            </span>
          </button>
        </div>

        {formOpen && (
          <form
            className="flex flex-col gap-2 rounded-xl border border-(--edge) p-3 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              addTracker();
            }}
          >
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-(--muted)">
              Name
              <input
                type="text"
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="Working hours, Task, Break…"
                className={inputCls}
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-(--muted)">
              Start
              <input
                type="time"
                required
                value={draft.start}
                onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-(--muted)">
              End
              <input
                type="time"
                required
                value={draft.end}
                onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                className={inputCls}
              />
            </label>
            <button
              type="submit"
              className="rounded-lg bg-(--accent) px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-(--accent-hover)"
            >
              Add
            </button>
          </form>
        )}
      </main>
  );

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-(--page) px-4 py-6 font-sans">
      {mainCard()}
      <button
        type="button"
        onClick={() => setHelpOpen(true)}
        className="mt-4 flex items-center gap-1.5 rounded-full border border-(--edge) px-3 py-1 text-xs text-(--ink-2) transition-colors hover:border-(--accent) hover:text-(--accent)"
      >
        <span className="flex h-4 w-4 items-center justify-center rounded-full border border-current text-[10px]">
          ?
        </span>
        How to use
      </button>
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {pipWin && createPortal(mainCard(true), pipWin.document.body)}
    </div>
  );
}
