/**
 * v0.4.4: SVG icon source → 1024×1024 PNG
 *
 * 用法: `node scripts/build-icon.mjs`
 *  输出: src-tauri/icons/icon.png (1024×1024)
 *
 * 之后跑 `pnpm tauri icon src-tauri/icons/icon.png` 生成全套平台 icon。
 */
import sharp from "sharp";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SVG = join(ROOT, "src-tauri/icons/icon-source.svg");
const OUT_PNG = join(ROOT, "src-tauri/icons/icon.png");

if (!existsSync(SVG)) {
  console.error(`✗ SVG source not found: ${SVG}`);
  process.exit(1);
}

const svg = readFileSync(SVG);

await sharp(svg, { density: 300 })
  .resize(1024, 1024)
  .png({ compressionLevel: 9 })
  .toFile(OUT_PNG);

console.log(`✓ Generated ${OUT_PNG} (1024×1024, retina-grade density 300)`);
