import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { createCanvas, loadImage } from 'canvas';

const router = Router();

/** GET /api/vision/templates — returns all templates as grouped pixel data */
router.get('/templates', async (_req, res) => {
  try {
    const templatesDir = path.join(process.cwd(), 'vision/templates');
    const groups: Record<string, Array<{ name: string; pixels: number[] }>> = {};

    async function loadDir(dir: string, groupKey: string) {
      const files = fs.readdirSync(dir)
        .filter(f => f.endsWith('.png') && !f.endsWith('.bak') && !f.endsWith('.bak2'));
      groups[groupKey] = [];
      for (const file of files) {
        const img = await loadImage(path.join(dir, file));
        const canvas = createCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, img.width, img.height);
        // Max-channel grayscale (matches Python digit_reader: np.max(tile, axis=2))
        const pixels: number[] = [];
        for (let i = 0; i < data.data.length; i += 4) {
          pixels.push(Math.max(data.data[i], data.data[i + 1], data.data[i + 2]) / 255);
        }
        groups[groupKey].push({ name: file.replace('.png', ''), pixels });
      }
    }

    await loadDir(path.join(templatesDir, 'digits'), '8x8');
    await loadDir(path.join(templatesDir, 'items'), '8x16');
    await loadDir(path.join(templatesDir, 'drops'), 'drops_8x16');
    await loadDir(path.join(templatesDir, 'enemies'), 'enemies_32x32');

    res.json(groups);
  } catch (err) {
    console.error('Template load failed:', err);
    res.status(500).json({ error: 'Template load failed', detail: String(err) });
  }
});

export { router as templateRouter };
