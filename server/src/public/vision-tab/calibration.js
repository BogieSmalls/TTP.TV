// calibration.js — In-browser auto-calibration for NES Zelda 1 HUD
// Scans a video frame for LIFE text, gameplay boundary, and B/A item borders.
// Returns CalibrationUniform or null if confidence is too low.

const LIFE_NES_Y = 40;
const NES_B_A_GAP = 32;          // NES pixels between B-item left border and A-item left border
const MIN_RED_PIXELS = 10;
const CONFIDENCE_THRESHOLD = 0.85;
const MAX_SCALE_Y_DIFF = 0.10;   // 10% disagreement between glyph and boundary measurements

export function scanCalibration(imageData, videoWidth, videoHeight) {
  const { data, width, height } = imageData;

  function pixel(x, y) {
    const i = (y * width + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2] };
  }

  const lifeResult = findLifeText(pixel, width, height);
  if (!lifeResult) return null;
  const { lifeTopY, lifeGlyphHeight } = lifeResult;

  const gameplayBoundaryY = findGameplayBoundary(pixel, lifeTopY, lifeGlyphHeight, width, height);
  if (gameplayBoundaryY === null) return null;

  const baResult = findBABorders(pixel, lifeTopY, lifeGlyphHeight, width, height);
  if (!baResult) return null;
  const { bItemLeftX, aItemLeftX } = baResult;

  const scaleYFromGlyph = lifeGlyphHeight / 8;
  const scaleYFromBoundary = (gameplayBoundaryY - lifeTopY) / (64 - LIFE_NES_Y);
  const scaleY = (scaleYFromGlyph + scaleYFromBoundary) / 2;
  const scaleX = (aItemLeftX - bItemLeftX) / NES_B_A_GAP;
  const cropY = lifeTopY - LIFE_NES_Y * scaleY;

  // Confidence: how much do the two scaleY estimates agree?
  const scaleYDiff = Math.abs(scaleYFromGlyph - scaleYFromBoundary) / scaleY;
  if (scaleYDiff > MAX_SCALE_Y_DIFF) return null;  // too much disagreement

  const confidence = 1.0 - scaleYDiff;

  return {
    cropX: 0,
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

function findLifeText(pixel, width, height) {
  // LIFE text is in the right half of the HUD (col 22-25 of the tile grid).
  // Scan rows 0..40% height for a run of red pixels.
  const xStart = Math.floor(width * 0.60);
  const xEnd   = Math.floor(width * 0.92);
  const yMax   = Math.floor(height * 0.40);

  for (let y = 0; y < yMax; y++) {
    let redCount = 0;
    for (let x = xStart; x < xEnd; x++) {
      const { r, g, b } = pixel(x, y);
      if (r > 50 && r > g * 2 && r > b * 2) redCount++;
    }
    if (redCount < MIN_RED_PIXELS) continue;

    // Found top of LIFE text — measure glyph height downward
    let glyphH = 1;
    for (let dy = 1; dy < 40; dy++) {
      let rc = 0;
      for (let x = xStart; x < xEnd; x++) {
        const { r, g, b } = pixel(x, y + dy);
        if (r > 50 && r > g * 2 && r > b * 2) rc++;
      }
      if (rc >= MIN_RED_PIXELS) {
        glyphH = dy + 1;
      } else if (dy > glyphH + 4) {
        break;  // no more red rows — glyph ended
      }
    }
    return { lifeTopY: y, lifeGlyphHeight: glyphH };
  }
  return null;
}

function findGameplayBoundary(pixel, lifeTopY, lifeGlyphHeight, width, height) {
  // The HUD/gameplay boundary is about (64-40)×scaleY = 24×scale pixels below LIFE top.
  // We don't know scale yet, so search in a generous window below the LIFE glyph.
  const searchStart = lifeTopY + lifeGlyphHeight + 2;
  const searchEnd   = Math.min(height, lifeTopY + lifeGlyphHeight * 5);

  for (let y = searchStart; y < searchEnd; y++) {
    // Count non-black pixels in the LEFT portion (gameplay area starts here)
    let nonBlack = 0;
    for (let x = 0; x < Math.min(width, 80); x++) {
      const { r, g, b } = pixel(x, y);
      if (r > 30 || g > 30 || b > 30) nonBlack++;
    }
    if (nonBlack >= 8) return y;
  }
  return null;
}

function findBABorders(pixel, lifeTopY, lifeGlyphHeight, width, height) {
  // B and A item slots are in the HUD, rows below LIFE text, left portion of screen.
  // Look for two blue left-border edges in the x range 2%-35% of width.
  const scanY   = Math.min(height - 1, lifeTopY + Math.round(lifeGlyphHeight * 2.5));
  const xStart  = Math.floor(width * 0.02);
  const xEnd    = Math.floor(width * 0.38);

  let bItemLeftX = null;
  let aItemLeftX = null;
  let inBlue = false;

  for (let x = xStart; x < xEnd; x++) {
    const { r, g, b } = pixel(x, scanY);
    const isBlue = b > 100 && b > r * 1.4 && b > g * 1.4;
    if (isBlue && !inBlue) {
      if (bItemLeftX === null) bItemLeftX = x;
      else if (aItemLeftX === null) { aItemLeftX = x; break; }
      inBlue = true;
    } else if (!isBlue) {
      inBlue = false;
    }
  }

  if (bItemLeftX === null || aItemLeftX === null) return null;
  return { bItemLeftX, aItemLeftX };
}
