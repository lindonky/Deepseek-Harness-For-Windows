// Generate build/icon.ico from the official dsh favicon (white bg + logo)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const svgPath = 'C:\\Epan\\DS Harness\\deepseek-harness\\apps\\web\\public\\favicon.svg';
const outDir = path.join(process.cwd(), 'build');
const svg = await readFile(svgPath);

const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) {
  const logo = await sharp(svg)
    .resize(Math.round(s * 0.86), Math.round(s * 0.86), { fit: 'contain' })
    .png()
    .toBuffer();
  const canvas = await sharp({
    create: { width: s, height: s, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toBuffer();
  pngs.push(canvas);
}

await mkdir(outDir, { recursive: true });
const ico = await pngToIco(pngs);
await writeFile(path.join(outDir, 'icon.ico'), ico);
// Also export a 256px png for reference / future use
await writeFile(path.join(outDir, 'icon.png'), pngs[pngs.length - 1]);
console.log('icon.ico generated:', ico.length, 'bytes; sizes:', sizes.join('/'));
