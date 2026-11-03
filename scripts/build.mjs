import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

const run = (command, args) => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

run("node", ["scripts/build-bridge.mjs"]);
mkdirSync("dist/main", { recursive: true });
mkdirSync("dist/preload", { recursive: true });
mkdirSync("dist/ocr/tessdata", { recursive: true });
copyFileSync(
  "node_modules/@tesseract.js-data/chi_sim/4.0.0/chi_sim.traineddata.gz",
  "dist/ocr/tessdata/chi_sim.traineddata.gz"
);
copyFileSync(
  "node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz",
  "dist/ocr/tessdata/eng.traineddata.gz"
);

await build({
  entryPoints: ["src/main/main.ts"],
  outfile: "dist/main/main.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron", "tesseract.js"],
  sourcemap: true
});

await build({
  entryPoints: ["src/preload/preload.ts"],
  outfile: "dist/preload/preload.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  sourcemap: true
});

await viteBuild();
