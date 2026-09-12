import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const NEXT_CONFIG_NAMES = [
  "next.config.ts",
  "next.config.js",
  "next.config.mjs"
];

const LAB_PREVIEW_ORIGIN_PATTERNS = [
  /127\.0\.0\.1:3100/u,
  /['"]127\.0\.0\.1['"]/u,
  /localhost:3100/u
];

/** @returns {boolean} */
export function isNextJsProject(workspace) {
  const packagePath = resolve(workspace, "package.json");
  if (!existsSync(packagePath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    return Boolean(
      manifest.dependencies?.next ?? manifest.devDependencies?.next
    );
  } catch {
    return false;
  }
}

/** @returns {string | null} absolute path */
export function findNextConfig(workspace) {
  for (const name of NEXT_CONFIG_NAMES) {
    const path = resolve(workspace, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Next.js 16+ blocks dev HMR when the browser loads from Mac :3100 but the dev
 * server listens on container :3000. Without allowedDevOrigins, client components
 * never hydrate (e.g. autoplay video stuck on poster).
 *
 * @returns {{ ok: boolean, configPath: string | null, detail: string }}
 */
export function inspectNextDevPreviewOrigins(workspace) {
  if (!isNextJsProject(workspace)) {
    return {
      ok: true,
      configPath: null,
      detail: "Not a Next.js project."
    };
  }
  const configPath = findNextConfig(workspace);
  if (!configPath) {
    return {
      ok: false,
      configPath: null,
      detail:
        "Next.js project has no next.config file; add allowedDevOrigins for Lab preview."
    };
  }
  const configText = readFileSync(configPath, "utf8");
  if (!/allowedDevOrigins/u.test(configText)) {
    return {
      ok: false,
      configPath,
      detail:
        'Add allowedDevOrigins: ["127.0.0.1:3100", "127.0.0.1"] to next.config and restart dev.'
    };
  }
  const allowsLab = LAB_PREVIEW_ORIGIN_PATTERNS.some((pattern) =>
    pattern.test(configText)
  );
  return {
    ok: allowsLab,
    configPath,
    detail: allowsLab
      ? "allowedDevOrigins includes a Lab preview host."
      : "allowedDevOrigins is present but missing 127.0.0.1:3100 (or 127.0.0.1)."
  };
}

/** One-line operator hint after starting a Next dev server. */
export function nextDevPreviewHint(workspace) {
  const report = inspectNextDevPreviewOrigins(workspace);
  if (report.ok || !isNextJsProject(workspace)) return null;
  return `Next.js dev via http://127.0.0.1:3100 needs allowedDevOrigins in ${report.configPath ?? "next.config"} — ${report.detail}`;
}
