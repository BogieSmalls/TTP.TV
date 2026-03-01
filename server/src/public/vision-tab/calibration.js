// calibration.js — In-browser auto-calibration for NES Zelda 1 HUD
// Derives crop and scale from LIFE text position + game area right edge.
// Returns CalibrationUniform or null if confidence is too low.

import { DEFAULT_LIFE_NES_X, DEFAULT_LIFE_NES_Y } from './tileGrid.js';

const LIFE_NES_Y = DEFAULT_LIFE_NES_Y;  // 16 — LIFE is on same row as rupees
const LIFE_NES_X = DEFAULT_LIFE_NES_X;  // 184 — col 24 (1-indexed), left edge of "-LIFE-"
const NES_WIDTH = 256;
const MIN_RED_PIXELS = 10;
const MAX_SCALE_XY_RATIO = 1.5;  // reject if scaleX/scaleY ratio exceeds this

export function scanCalibration(imageData, videoWidth, videoHeight) {
  const { data, width, height } = imageData;

  function pixel(x, y) {
    const i = (y * width + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2] };
  }

  const candidates = findLifeTextCandidates(pixel, width, height);
  if (candidates.length === 0) {
    const xStart = Math.floor(width * 0.05);
    const xEnd   = Math.floor(width * 0.95);
    const yMax   = Math.floor(height * 0.40);
    let maxRed = 0;
    for (let y = 0; y < yMax; y++) {
      let rc = 0;
      for (let x = xStart; x < xEnd; x++) {
        const { r, g, b } = pixel(x, y);
        if (r > 50 && r > g * 2 && r > b * 2) rc++;
      }
      if (rc > maxRed) maxRed = rc;
    }
    console.warn(`calibration: no LIFE text found. maxRedPixels=${maxRed} (need ${MIN_RED_PIXELS}), scan x=${xStart}-${xEnd} y=0-${yMax}, video=${width}x${height}`);
    return null;
  }

  for (const { lifeTopY, lifeGlyphHeight, lifeLeftX } of candidates) {
    const scaleY = lifeGlyphHeight / 8;

    // Find the RIGHT edge of the game area (clean — overlays are on the left).
    // Then derive scaleX from the distance between LIFE text and the right edge:
    //   lifeLeftX = cropX + LIFE_NES_X * scaleX
    //   rightEdge + 1 = cropX + NES_WIDTH * scaleX
    // => scaleX = (rightEdge + 1 - lifeLeftX) / (NES_WIDTH - LIFE_NES_X)
    const rightEdge = findGameRightEdge(pixel, lifeTopY, lifeGlyphHeight, width, height);
    if (rightEdge === null) continue;

    const scaleX = (rightEdge + 1 - lifeLeftX) / (NES_WIDTH - LIFE_NES_X);
    if (scaleX <= 0) continue;

    const cropX = rightEdge + 1 - NES_WIDTH * scaleX;
    const cropY = lifeTopY - LIFE_NES_Y * scaleY;

    // Reject if scaleX and scaleY are wildly different
    const ratio = Math.max(scaleX, scaleY) / Math.min(scaleX, scaleY);
    if (ratio > MAX_SCALE_XY_RATIO) {
      console.warn(`  candidate y=${lifeTopY}: scaleX/scaleY ratio ${ratio.toFixed(2)} > ${MAX_SCALE_XY_RATIO} (scaleX=${scaleX.toFixed(2)}, scaleY=${scaleY.toFixed(2)}, cropX=${Math.round(cropX)}, rightEdge=${rightEdge}, lifeLeftX=${lifeLeftX})`);
      continue;
    }

    const confidence = 1.0 / ratio;

    return {
      cropX: Math.round(cropX),
      cropY: Math.round(cropY),
      scaleX,
      scaleY,
      gridDx: 0,
      gridDy: 0,
      videoWidth,
      videoHeight,
      confidence,
    };
  }

  console.warn(`calibration: ${candidates.length} LIFE candidates tried, none valid. y=[${candidates.map(c => `${c.lifeTopY}(h${c.lifeGlyphHeight})`).join(',')}]`);
  return null;
}

function findLifeTextCandidates(pixel, width, height) {
  // LIFE text is in the right half of the HUD (col 22-25 of the tile grid).
  // Scan rows 0..40% height for runs of red pixels.
  // Returns ALL candidates since stream overlays (timers) can create false positives.
  // Scan the full width — game area can be left, center, or right of the stream.
  const xStart = Math.floor(width * 0.05);
  const xEnd   = Math.floor(width * 0.95);
  const yMax   = Math.floor(height * 0.40);
  const results = [];

  let y = 0;
  while (y < yMax) {
    let redCount = 0;
    let leftX = -1, rightX = -1;
    for (let x = xStart; x < xEnd; x++) {
      const { r, g, b } = pixel(x, y);
      if (r > 50 && r > g * 2 && r > b * 2) {
        redCount++;
        if (leftX < 0) leftX = x;
        rightX = x;
      }
    }
    if (redCount < MIN_RED_PIXELS) { y++; continue; }

    // Found top of a red region — measure glyph height downward,
    // and track the widest red extent across all rows of the glyph.
    let glyphH = 1;
    let maxLeftX = leftX, maxRightX = rightX;
    for (let dy = 1; dy < 40; dy++) {
      let rc = 0;
      for (let x = xStart; x < xEnd; x++) {
        const { r, g, b } = pixel(x, y + dy);
        if (r > 50 && r > g * 2 && r > b * 2) {
          rc++;
          if (x < maxLeftX) maxLeftX = x;
          if (x > maxRightX) maxRightX = x;
        }
      }
      if (rc >= MIN_RED_PIXELS) {
        glyphH = dy + 1;
      } else if (dy > glyphH + 4) {
        break;
      }
    }
    results.push({ lifeTopY: y, lifeGlyphHeight: glyphH, lifeLeftX: maxLeftX, lifeRightX: maxRightX });
    y += glyphH + 5;
  }
  return results;
}

function findGameRightEdge(pixel, lifeTopY, lifeGlyphHeight, width, height) {
  // Scan rows in the gameplay area (below the HUD) from the RIGHT edge of the
  // video inward, looking for the rightmost non-black pixel.  The right edge
  // is reliable because stream overlays (webcam, timer, chat) are typically on
  // the left side; the game area extends to the right edge or has a clean black
  // right pillarbox.
  const scanStart = Math.min(height - 1, lifeTopY + Math.round(lifeGlyphHeight * 4));
  const scanEnd   = Math.min(height, scanStart + Math.round(lifeGlyphHeight * 8));

  let rightEdge = 0;

  for (let y = scanStart; y < scanEnd; y++) {
    for (let x = width - 1; x >= 0; x--) {
      const { r, g, b } = pixel(x, y);
      if (r > 30 || g > 30 || b > 30) {
        if (x > rightEdge) rightEdge = x;
        break;
      }
    }
  }

  if (rightEdge <= 0) {
    console.warn(`calibration: findGameRightEdge failed. scanY=${scanStart}-${scanEnd}, video=${width}x${height}`);
    return null;
  }
  return rightEdge;
}
