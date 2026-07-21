import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const svgPath = path.join(__dirname, "icon.svg");
const outDir = path.join(__dirname, "..");

const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const outPath = path.join(outDir, `icon-${size}.png`);
  await sharp(svgPath).resize(size, size).png().toFile(outPath);
  console.log(`generated ${outPath}`);
}
