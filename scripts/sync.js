#!/usr/bin/env node
/**
 * Sync script — builds the plugin and creates a symlink to the OpenCode plugin directory.
 *
 * Usage: node scripts/sync.js
 *
 * What it does:
 * 1. Builds the TypeScript source (npm run build)
 * 2. Writes a minimal package.json to dist/ (name, version, main, types, peerDependencies)
 * 3. Creates/replaces a symlink in ~/.config/opencode/plugins/opencode-auto-continue
 *    pointing to the dist/ directory
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DIST_DIR = path.join(PROJECT_ROOT, "dist");
const PLUGIN_DIR = path.join(
  process.env.HOME || "/tmp",
  ".config",
  "opencode",
  "plugins",
  "opencode-auto-continue"
);

async function main() {
  // Step 1: Build
  console.log("Building...");
  execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });

  // Step 2: Write minimal package.json to dist/
  const pkg = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")
  );
  const distPkg = {
    name: pkg.name,
    version: pkg.version,
    main: "./index.js",
    types: "./index.d.ts",
    description: pkg.description,
    peerDependencies: pkg.peerDependencies,
  };
  fs.writeFileSync(
    path.join(DIST_DIR, "package.json"),
    JSON.stringify(distPkg, null, 2) + "\n"
  );
  console.log(`sync: dist/package.json v${pkg.version}`);

  // Step 3: Create/replace symlink
  let needLink = true;
  try {
    const stat = fs.lstatSync(PLUGIN_DIR);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(PLUGIN_DIR);
      if (target === path.resolve(DIST_DIR)) {
        console.log("symlink already correct:", PLUGIN_DIR, "->", target);
        needLink = false;
      } else {
        console.log("replacing stale symlink:", PLUGIN_DIR, "(was", target, ")");
        fs.unlinkSync(PLUGIN_DIR);
      }
    } else {
      console.log("removing existing plugin dir:", PLUGIN_DIR);
      fs.rmSync(PLUGIN_DIR, { recursive: true, force: true });
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.log("check symlink:", e.message);
  }

  if (needLink) {
    // Ensure parent directory exists
    fs.mkdirSync(path.dirname(PLUGIN_DIR), { recursive: true });
    fs.symlinkSync(path.resolve(DIST_DIR), PLUGIN_DIR, "dir");
    console.log("created symlink:", PLUGIN_DIR, "->", path.resolve(DIST_DIR));
  }
}

main().catch((e) => {
  console.error("sync failed:", e);
  process.exit(1);
});