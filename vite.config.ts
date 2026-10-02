import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Ergänzt og:image/og:url mit absoluter URL, wenn VITE_SITE_URL gesetzt ist. */
function openGraphImage(siteUrl: string | undefined): Plugin {
  return {
    name: "arcane-open-graph-image",
    transformIndexHtml(html) {
      if (!siteUrl) return html;
      const base = siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
      return {
        html,
        tags: [
          { tag: "meta", attrs: { property: "og:image", content: new URL("ad_logo_512.png", base).toString() }, injectTo: "head" },
          { tag: "meta", attrs: { property: "og:url", content: base }, injectTo: "head" }
        ]
      };
    }
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    plugins: [react(), openGraphImage(env.VITE_SITE_URL?.trim() || undefined)],
    base: "./",
    build: { target: "es2022" }
  };
});
