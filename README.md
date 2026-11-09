# Time Box

A live clock that makes you feel time passing — with day-completion and custom
time-range progress shown as cycles.

**Production:** [https://timer-box.vercel.app/](https://timer-box.vercel.app/)

![Time Box](app/favicon.ico)

## Features

- **Live clock** — hours, minutes, seconds, and a tenths-of-a-second digit
  (one tick every 0.1 s), updated every animation frame.
- **Day cycle** — a progress ring showing how much of today has passed
  (at 12:00 it reads 50%), with the time left in the day.
- **Custom timers** — add your own time ranges (working hours, a task, a
  break…) with start and end times. Each renders as a colored progress ring
  with the time left, "Starts in…", or "Done". Progress is monotonic: once a
  range has passed, it stays at 100% and never resets during the day.
  Overnight ranges (e.g. 22:00–06:00) are supported. Timers are saved in the
  browser (localStorage) and sync across tabs.
- **Open in app** — the site is an installable PWA (web app manifest +
  icons). In browsers that support installation (Chrome/Edge), an **Open in
  app** button appears in the header; it triggers the browser's install
  prompt and opens Time Box as a standalone application window with its own
  icon in the taskbar/dock. Once installed the button disappears (launch it
  from the OS instead).
- **Floating widget** — the **Widget** button pops the Time Box into a small
  always-on-top window:
  - **Web** (Chrome/Edge): uses the Document Picture-in-Picture API. The
    widget shows the Time Box content flat (no card frame), always in light
    mode, and stays above other windows. The button is hidden in browsers
    without the API (Firefox/Safari).
  - **Desktop app** (Electron): swaps to a tiny frameless, draggable,
    always-on-top pill with the clock and the day ring.

## Scripts

| Command           | What it does                                                   |
| ----------------- | -------------------------------------------------------------- |
| `npm run dev`     | Start the Next.js dev server at `http://localhost:3000`.       |
| `npm run build`   | Build the static export into `out/`.                           |
| `npm run app`     | Build, then open the desktop app (always-on-top window).       |
| `npm run app:dev` | Open the desktop app pointed at the running dev server.        |
| `npm run lint`    | Run ESLint.                                                    |

## Deployment

The production site is deployed on Vercel at
[https://timer-box.vercel.app/](https://timer-box.vercel.app/).

The project uses `output: "export"` (static export), so no special Vercel
configuration is needed — `next build` produces the site. Everything is
client-side; the floating widget works over HTTPS out of the box.

## Desktop app

`electron/main.js` serves the static export from `out/` on a fixed local port
(so saved timers persist between launches) and opens a compact window at the
highest always-on-top level — new windows open underneath it. The **Widget**
button shrinks it to a frameless mini-pill; the pill's arrow button expands it
back.

Note: the desktop app and the website are different origins, so each keeps its
own timer list.

## Tech

- [Next.js](https://nextjs.org) 16 (App Router, static export) + React 19
- Tailwind CSS 4, with design tokens (light/dark) defined in
  `app/globals.css`
- Electron (dev dependency) for the desktop app
- Colors come from a colorblind-validated palette; each progress ring pairs a
  hue with a lighter track of the same hue, re-stepped separately for dark
  mode.
