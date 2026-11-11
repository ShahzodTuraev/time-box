const { app, BrowserWindow, ipcMain } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const DEV_URL = "http://localhost:3000";
// Fixed port so the app keeps one origin across launches — localStorage
// (the saved timers) lives per origin.
const APP_PORT = 38479;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain",
};

// Serves the static export in `out/`.
function serveOut() {
  const root = path.join(__dirname, "..", "out");
  const server = http.createServer((req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
      if (p.endsWith("/")) p += "index.html";
      let file = path.normalize(path.join(root, p));
      if (!file.startsWith(root)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) {
        file = `${file}.html`;
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.setHeader(
        "Content-Type",
        MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      );
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(APP_PORT, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${APP_PORT}/`),
    );
  });
}

let baseUrl = "";

function createWindow(widget, position) {
  const common = {
    alwaysOnTop: true,
    autoHideMenuBar: true,
    title: "Time Box",
    icon: path.join(__dirname, "..", "app", "favicon.ico"),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  };
  const win = widget
    ? new BrowserWindow({
        ...common,
        width: 480,
        height: 110,
        frame: false,
        transparent: true,
        resizable: false,
      })
    : new BrowserWindow({
        ...common,
        width: 640,
        height: 460,
        minWidth: 380,
        minHeight: 300,
        backgroundColor: "#f9f9f7",
      });
  if (position) win.setPosition(position.x, position.y);
  // "screen-saver" is the highest always-on-top level, so other windows,
  // including other topmost ones, open underneath the time box.
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadURL(widget ? `${baseUrl}?widget=1` : baseUrl);
}

process.on("uncaughtException", (e) => console.error("uncaught:", e));
process.on("unhandledRejection", (e) => console.error("unhandled:", e));

app.whenReady().then(async () => {
  baseUrl = process.argv.includes("--dev") ? `${DEV_URL}/` : await serveOut();
  createWindow(false);
});

// Swap between the full window and the widget, keeping the screen position.
// The new window is created before the old one closes, so the app never
// hits "all windows closed" mid-swap.
ipcMain.on("set-widget", (event, on) => {
  const current = BrowserWindow.fromWebContents(event.sender);
  const position = current
    ? { x: current.getPosition()[0], y: current.getPosition()[1] }
    : undefined;
  createWindow(!!on, position);
  current?.close();
});

app.on("window-all-closed", () => app.quit());
