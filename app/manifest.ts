import type { MetadataRoute } from "next";

// Required for `output: "export"` — the manifest is emitted at build time.
export const dynamic = "force-static";

// Web app manifest — makes the site installable, so the browser's
// "Open in app" button can launch it as a standalone application window.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Time Box",
    short_name: "Time Box",
    description: "The current time, down to tenths of a second.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#2a78d6",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
