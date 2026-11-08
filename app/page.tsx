"use client";

import { useEffect, useState } from "react";

declare global {
  interface Window {
    // Exposed by the Electron preload script; absent in the browser.
    timebox?: { setWidget: (on: boolean) => void };
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
  { fill: "stroke-(--series-1)", track: "stroke-(--series-1-track)" },
  { fill: "stroke-(--series-2)", track: "stroke-(--series-2-track)" },
  { fill: "stroke-(--series-3)", track: "stroke-(--series-3-track)" },
  { fill: "stroke-(--series-4)", track: "stroke-(--series-4-track)" },
  { fill: "stroke-(--series-5)", track: "stroke-(--series-5-track)" },
  { fill: "stroke-(--series-6)", track: "stroke-(--series-6-track)" },
  { fill: "stroke-(--series-7)", track: "stroke-(--series-7-track)" },
];

const DAY_COLOR = { fill: "stroke-(--day)", track: "stroke-(--day-track)" };

const DEFAULT_TRACKERS: Tracker[] = [
  { id: "work", label: "Working hours", start: "09:00", end: "18:00", color: 0 },
  { id: "break", label: "Break", start: "12:00", end: "13:00", color: 1 },
];

const STORAGE_KEY = "time-box-trackers";

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
      return { pct: 0, status: `Starts in ${fmtDur(startM - nowMin)}` };
    if (nowMin >= endM) return { pct: 100, status: "Done" };
    return {
      pct: ((nowMin - startM) / (endM - startM)) * 100,
      status: `${fmtDur(endM - nowMin)} left`,
    };
  }

  // Range crosses midnight (e.g. 22:00 – 06:00).
  const duration = endM - startM + 1440;
  if (nowMin >= startM)
    return {
      pct: ((nowMin - startM) / duration) * 100,
      status: `${fmtDur(startM + duration - nowMin)} left`,
    };
  if (nowMin < endM)
    return {
      pct: ((nowMin + 1440 - startM) / duration) * 100,
      status: `${fmtDur(endM - nowMin)} left`,
    };
  // Daytime gap after this morning's end: already finished — stays at 100%.
  return { pct: 100, status: "Done" };
}

function Ring({
  pct,
  color,
  label,
  center,
  sizeClass = "h-20 w-20",
}: {
  pct: number;
  color: { fill: string; track: string };
  label: string;
  center?: React.ReactNode;
  sizeClass?: string;
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

export default function Home() {
  const [now, setNow] = useState<Date | null>(null);
  const [trackers, setTrackers] = useState<Tracker[]>(DEFAULT_TRACKERS);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState({ label: "", start: "09:00", end: "17:00" });
  const [isApp, setIsApp] = useState(false);
  const [widgetView, setWidgetView] = useState(false);

  useEffect(() => {
    setIsApp(typeof window.timebox !== "undefined");
    if (new URLSearchParams(window.location.search).has("widget")) {
      setWidgetView(true);
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
    } catch {
      // storage unavailable — keep defaults
    }

    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || e.newValue === null) return;
      try {
        setTrackers(JSON.parse(e.newValue));
      } catch {
        // ignore malformed values from other tabs
      }
    };
    window.addEventListener("storage", onStorage);

    let frame: number;
    const tick = () => {
      setNow(new Date());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

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

  let clock = { hh: "--", mm: "--", ss: "--", tenth: "-" };
  let dateLine = " ";
  let dayPct = 0;
  let remaining = "";
  let nowMin = 0;

  if (now) {
    const ms = now.getMilliseconds();
    const s = now.getSeconds();
    const m = now.getMinutes();
    const h = now.getHours();

    clock = {
      hh: pad(h),
      mm: pad(m),
      ss: pad(s),
      tenth: String(Math.floor(ms / 100)),
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
  }

  if (widgetView) {
    return (
      <div className="app-drag flex h-dvh w-screen items-center gap-3 rounded-2xl border border-(--edge) bg-(--surface) px-4 font-sans shadow-lg">
        <Ring
          pct={dayPct}
          color={DAY_COLOR}
          label="Day"
          sizeClass="h-12 w-12"
          center={
            <span className="text-[10px]">
              {Math.round(dayPct)}
              <span className="text-[8px] font-normal text-(--muted)">%</span>
            </span>
          }
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="font-mono text-2xl font-semibold leading-none tabular-nums text-(--ink)">
            {clock.hh}:{clock.mm}:{clock.ss}
            <span className="text-(--accent)">.{clock.tenth}</span>
          </p>
          <p className="mt-1 truncate text-[11px] text-(--muted)">
            {remaining} today
          </p>
        </div>
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
      </div>
    );
  }

  const inputCls =
    "rounded-lg border border-(--edge) bg-transparent px-2.5 py-1.5 text-sm text-(--ink) outline-none focus:border-(--accent)";

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-(--page) px-4 py-6 font-sans">
      <main
        className="flex w-full max-w-xl flex-col gap-5 rounded-2xl border border-(--edge) bg-(--surface) p-6 shadow-sm sm:p-8"
        suppressHydrationWarning
      >
        {/* Header */}
        <header className="flex items-center justify-between">
          <h1 className="text-xs font-semibold uppercase tracking-[0.3em] text-(--muted)">
            Time Box
          </h1>
          <div className="flex items-center gap-3">
            <p className="text-xs text-(--ink-2)">{dateLine}</p>
            {isApp && (
              <button
                type="button"
                onClick={() => window.timebox?.setWidget(true)}
                title="Shrink to a floating widget"
                className="rounded-full border border-(--edge) px-2.5 py-0.5 text-[11px] text-(--ink-2) transition-colors hover:border-(--accent) hover:text-(--accent)"
              >
                Widget
              </button>
            )}
          </div>
        </header>

        {/* Clock — hero figure */}
        <p className="text-center font-mono text-5xl font-semibold tabular-nums text-(--ink)">
          {clock.hh}:{clock.mm}:{clock.ss}
          <span className="text-(--accent)">.{clock.tenth}</span>
        </p>

        <hr className="border-0 border-t border-(--hairline)" />

        {/* Cycles: day first, then timers, then add */}
        <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4">
          <div className="flex flex-col items-center gap-1.5 text-center">
            <Ring
              pct={dayPct}
              color={DAY_COLOR}
              label="Day"
              center={
                <span className="text-base">
                  {dayPct.toFixed(1)}
                  <span className="text-xs font-normal text-(--muted)">%</span>
                </span>
              }
            />
            <div className="flex flex-col">
              <span className="text-xs font-medium text-(--ink)">Day</span>
              <span className="text-[11px] text-(--muted)">{remaining}</span>
            </div>
          </div>

          {trackers.map((tracker) => {
            const color = RING_COLORS[tracker.color % RING_COLORS.length];
            const state = now
              ? trackerState(tracker, nowMin)
              : { pct: 0, status: " " };
            return (
              <div
                key={tracker.id}
                className="group relative flex flex-col items-center gap-1.5 text-center"
              >
                <button
                  type="button"
                  onClick={() =>
                    persist(trackers.filter((t) => t.id !== tracker.id))
                  }
                  aria-label={`Remove ${tracker.label}`}
                  className="absolute -top-1 right-0 hidden h-6 w-6 items-center justify-center rounded-full text-(--muted) hover:bg-(--wash) group-hover:flex"
                >
                  ×
                </button>
                <Ring pct={state.pct} color={color} label={tracker.label} />
                <div className="flex flex-col">
                  <span className="max-w-24 truncate text-xs font-medium text-(--ink)">
                    {tracker.label}
                  </span>
                  <span className="text-[11px] tabular-nums text-(--ink-2)">
                    {tracker.start} – {tracker.end}
                  </span>
                  <span className="text-[11px] text-(--muted)">
                    {state.status}
                  </span>
                </div>
              </div>
            );
          })}

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
    </div>
  );
}
