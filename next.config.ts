import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Static export so the Electron app can serve the page from `out/`.
  // cacheComponents/partialPrefetching (PPR) are unsupported in export mode.
  output: "export",
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
