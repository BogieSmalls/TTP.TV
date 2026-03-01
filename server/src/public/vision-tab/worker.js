'use strict';

import { scanCalibration } from './calibration.js';
import { GpuContext } from './gpu.js';
import { VisionPipeline } from './pipeline.js';
import { TILE_DEFS, applyLandmarks } from './tileDefs.js';

// Current tile defs (updated when landmarks are applied)
let currentTileDefs = TILE_DEFS;

const params = new URLSearchParams(location.search);
const racerId = params.get('racerId');
const streamUrl = params.get('streamUrl');
const calib = JSON.parse(params.get('calib') || '{}');
const landmarks = params.has('landmarks') ? JSON.parse(params.get('landmarks')) : null;
const startOffset = params.has('startOffset') ? Number(params.get('startOffset')) : null;

const gpu = new GpuContext();
let gpuReady = false;
let pipeline = null;

gpu.init().then(async () => {
  pipeline = new VisionPipeline(gpu, calib);
  gpuReady = true;
  console.log('GPU ready, pipeline initialized');

  // Load room templates for overworld map matching (async, non-blocking)
  try {
    const resp = await fetch('/api/vision/room-template-pixels');
    if (resp.ok) {
      const rooms = await resp.json();
      pipeline._initRoomPipeline(rooms);
      // Write room calibration from main calib
      pipeline._updateRoomCalib({
        scale_x: calib.scaleX, scale_y: calib.scaleY,
        offset_x: calib.cropX,  offset_y: calib.cropY,
        video_w: calib.videoWidth, video_h: calib.videoHeight,
      });
      console.log(`Room templates loaded: ${rooms.length} rooms`);
    }
  } catch (e) { console.warn('Room template load failed:', e); }
}).catch(e => console.error('GPU init failed:', e));

// ── WebSocket ──────────────────────────────────────────────────────────────
const ws = new WebSocket(`ws://${location.host}/vision-tab-ws?racerId=${racerId}`);
ws.addEventListener('open', () => console.log('WS connected'));
ws.addEventListener('message', (ev) => handleServerMessage(JSON.parse(ev.data)));

function handleServerMessage(msg) {
  if (msg.type === 'requestPreview') sendPreview();
  if (msg.type === 'recalibrate') Object.assign(calib, msg.calib);
  if (msg.type === 'startDebugStream') { debugStreamActive = true; }
  if (msg.type === 'stopDebugStream') { debugStreamActive = false; }
}

// ── Video ──────────────────────────────────────────────────────────────────
const video = document.getElementById('video');
video.src = streamUrl;
video.play().catch(e => console.error('video play failed:', e));

let frameCount = 0;
let debugStreamActive = false;
let lastFrameTime = Date.now();
let lastHeartTiles = null;
let lastMinimapCells = null;

// Off-screen canvas for tile color sampling (reused each frame)
const colorCanvas = document.createElement('canvas');
colorCanvas.width = 16;
colorCanvas.height = 16;
const colorCtx = colorCanvas.getContext('2d', { willReadFrequently: true });
const COLOR_BRIGHT_THRESH = 40 / 255; // min max-channel brightness to count as sprite pixel

/** Sample average RGB of bright pixels in a tile region from the video frame. */
function sampleTileColor(tile) {
  if (!calibration) return { r: 0, g: 0, b: 0 };
  const gdx = calibration.gridDx ?? 0;
  const gdy = calibration.gridDy ?? 0;
  const tileH = tile.size === '8x16' ? 16 : 8;
  // Stream pixel coordinates of the tile
  const sx = calibration.cropX + (tile.nesX + gdx) * calibration.scaleX;
  const sy = calibration.cropY + (tile.nesY + gdy) * calibration.scaleY;
  const sw = 8 * calibration.scaleX;
  const sh = tileH * calibration.scaleY;
  // Draw just the tile region from video to the small canvas
  colorCanvas.width = Math.max(1, Math.round(sw));
  colorCanvas.height = Math.max(1, Math.round(sh));
  colorCtx.drawImage(video, sx, sy, sw, sh, 0, 0, colorCanvas.width, colorCanvas.height);
  const imgData = colorCtx.getImageData(0, 0, colorCanvas.width, colorCanvas.height);
  const d = imgData.data;
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let i = 0; i < d.length; i += 4) {
    const maxCh = Math.max(d[i], d[i + 1], d[i + 2]) / 255;
    if (maxCh > COLOR_BRIGHT_THRESH) {
      sumR += d[i];
      sumG += d[i + 1];
      sumB += d[i + 2];
      count++;
    }
  }
  if (count < 3) return { r: 0, g: 0, b: 0 };
  return { r: sumR / count, g: sumG / count, b: sumB / count };
}

// Off-screen canvas for heart tile sampling (64×16 = 8 hearts × 2 rows of 8px)
const heartCanvas = document.createElement('canvas');
heartCanvas.width = 64;
heartCanvas.height = 16;
const heartCtx = heartCanvas.getContext('2d', { willReadFrequently: true });

/**
 * Sample heart tiles using 3-color classification:
 *   Black (background): max(R,G,B) < 50
 *   White (outline):    min(R,G,B) > 150  (all channels high = desaturated white)
 *   Color (fill):       max(R,G,B) > 80 AND not white  (saturated heart color)
 *
 * Full heart  = color + black (no white outline visible — fill covers it)
 * Half heart  = color + white + black (left fill + right outline)
 * Empty heart = white + black (outline only, no fill)
 * Empty slot  = black only
 */
function sampleHearts() {
  if (!calibration || !landmarks) return null;
  const lm = landmarks.find(l => l.label === 'Hearts');
  if (!lm) return null;
  const gdx = calibration.gridDx ?? 0;
  const gdy = calibration.gridDy ?? 0;
  const sx = calibration.cropX + (lm.x + gdx) * calibration.scaleX;
  const sy = calibration.cropY + (lm.y + gdy) * calibration.scaleY;
  const sw = lm.w * calibration.scaleX;
  const sh = lm.h * calibration.scaleY;
  heartCanvas.width = 64;
  heartCanvas.height = 16;
  heartCtx.drawImage(video, sx, sy, sw, sh, 0, 0, 64, 16);
  const imgData = heartCtx.getImageData(0, 0, 64, 16);
  const d = imgData.data;
  const tiles = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 8; col++) {
      let colorCount = 0;
      let whiteCount = 0;
      let brightnessSum = 0;
      const totalPixels = 64; // 8×8
      for (let py = 0; py < 8; py++) {
        for (let px = 0; px < 8; px++) {
          const idx = ((row * 8 + py) * 64 + (col * 8 + px)) * 4;
          const r = d[idx], g = d[idx + 1], b = d[idx + 2];
          const maxCh = Math.max(r, g, b);
          const minCh = Math.min(r, g, b);
          brightnessSum += maxCh;
          if (minCh > 100) {
            whiteCount++;         // all channels high → white/near-white pixel
          } else if (maxCh > 80 && (maxCh - minCh) > 50) {
            colorCount++;         // bright AND saturated → heart fill color
          }
          // else: black background pixel
        }
      }
      tiles.push({
        colorRatio: colorCount / totalPixels,
        whiteRatio: whiteCount / totalPixels,
        brightness: brightnessSum / totalPixels,
      });
    }
  }
  return tiles;
}

// Off-screen canvas for minimap dot sampling (64×32 = overworld minimap region)
const minimapCanvas = document.createElement('canvas');
minimapCanvas.width = 64;
minimapCanvas.height = 32;
const minimapCtx = minimapCanvas.getContext('2d', { willReadFrequently: true });

/**
 * Sample minimap cells for Link's dot detection.
 * Overworld minimap: 16×8 grid, each cell 4×4 NES pixels.
 * Link's dot (any tunic color) has high saturation against uniform gray background.
 * Returns 128 saturation values (max(R,G,B) - min(R,G,B) per cell).
 */
function sampleMinimap() {
  if (!calibration || !landmarks) return null;
  const lm = landmarks.find(l => l.label === 'Minimap');
  if (!lm) return null;
  const gdx = calibration.gridDx ?? 0;
  const gdy = calibration.gridDy ?? 0;
  const sx = calibration.cropX + (lm.x + gdx) * calibration.scaleX;
  const sy = calibration.cropY + (lm.y + gdy) * calibration.scaleY;
  const sw = lm.w * calibration.scaleX;
  const sh = lm.h * calibration.scaleY;
  minimapCanvas.width = 64;
  minimapCanvas.height = 32;
  minimapCtx.drawImage(video, sx, sy, sw, sh, 0, 0, 64, 32);
  const imgData = minimapCtx.getImageData(0, 0, 64, 32);
  const d = imgData.data;
  const cells = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 16; col++) {
      let satSum = 0;
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const idx = ((row * 4 + py) * 64 + (col * 4 + px)) * 4;
          const maxCh = Math.max(d[idx], d[idx + 1], d[idx + 2]);
          const minCh = Math.min(d[idx], d[idx + 1], d[idx + 2]);
          satSum += (maxCh - minCh);
        }
      }
      cells.push(satSum / 16); // average saturation per cell (16 pixels)
    }
  }
  return cells;
}

async function onVideoFrame(now, metadata) {
  lastFrameTime = Date.now();
  frameCount++;
  // Heartbeat every 30 frames
  if (frameCount % 30 === 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'heartbeat', racerId, frameCount }));
  }
  if (gpuReady && pipeline) {
    const aggregates = await pipeline.processFrame(video);
    if (frameCount % 30 === 0) {
      console.log('aggregates:', JSON.stringify(aggregates));
    }
    // Sample tile colors for shape twin disambiguation
    const tileColors = currentTileDefs.map(sampleTileColor);
    const heartTiles = sampleHearts();
    lastHeartTiles = heartTiles;
    const minimapCells = sampleMinimap();
    lastMinimapCells = minimapCells;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'rawState',
        racerId,
        frameNumber: frameCount,
        timestamp: Date.now(),
        tileColors,
        heartTiles,
        minimapCells,
        ...aggregates,  // includes hudScores, roomScores, floorItems from pipeline
      }));
    }
    if (debugStreamActive) {
      sendDebugFrame();
    }
  }
  video.requestVideoFrameCallback(onVideoFrame);
}

// ── Calibration phase ─────────────────────────────────────────────────────
const calibCanvas = document.createElement('canvas');
let calibration = null;
let calibFrameCount = 0;

function sendCalibrationPreview() {
  // Send a 320x180 JPEG of the current video frame so the dashboard can show
  // what the tab is actually seeing during calibration.
  const preview = document.createElement('canvas');
  preview.width = 320;
  preview.height = Math.round(320 * video.videoHeight / Math.max(1, video.videoWidth));
  preview.getContext('2d').drawImage(video, 0, 0, preview.width, preview.height);
  preview.toBlob(blob => {
    if (!blob || ws.readyState !== WebSocket.OPEN) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'debugFrame', racerId, jpeg: base64 }));
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/jpeg', 0.6);
}

async function calibrationFrame() {
  calibFrameCount++;
  calibCanvas.width = video.videoWidth;
  calibCanvas.height = video.videoHeight;
  const ctx = calibCanvas.getContext('2d');
  ctx.drawImage(video, 0, 0);

  // Send a preview every 15 frames during calibration so the dashboard can show
  // what the video looks like even before calibration succeeds.
  if (calibFrameCount % 15 === 1) {
    sendCalibrationPreview();
    console.log(`[${racerId}] Calibration scan frame ${calibFrameCount}, video ${video.videoWidth}x${video.videoHeight}`);
  }

  const imageData = ctx.getImageData(0, 0, video.videoWidth, video.videoHeight);
  const result = scanCalibration(imageData, video.videoWidth, video.videoHeight);

  if (result) {
    calibration = result;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'calibration', racerId, calibration }));
    }
    console.log(`[${racerId}] Calibration locked (${calibFrameCount} frames):`, result);
    startDetectionLoop();
  } else if (calibFrameCount >= 120) {
    // Fallback: unit scale, no crop — still functional for test streams
    calibration = { cropX: 0, cropY: 0, scaleX: 1, scaleY: 1, gridDx: 1, gridDy: 2,
                    videoWidth: video.videoWidth, videoHeight: video.videoHeight };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'calibration', racerId, calibration }));
    }
    console.warn(`[${racerId}] Calibration fallback after ${calibFrameCount} frames (${video.videoWidth}x${video.videoHeight})`);
    startDetectionLoop();
  } else {
    video.requestVideoFrameCallback(calibrationFrame);
  }
}

function startDetectionLoop() {
  video.requestVideoFrameCallback(onVideoFrame);
}

// Start calibration when video is ready; seek to startOffset for VODs
video.addEventListener('loadeddata', () => {
  // If the server already provided calibration with valid scale values, use it directly
  // and skip the in-browser auto-detection phase entirely.
  const calibProvided = calib && calib.scaleX > 0 && calib.scaleY > 0;

  const startFn = calibProvided
    ? () => {
        // Scale crop values if actual video resolution differs from crop profile's reference
        const sx = video.videoWidth / (calib.videoWidth || video.videoWidth);
        const sy = video.videoHeight / (calib.videoHeight || video.videoHeight);
        calibration = {
          cropX: calib.cropX * sx,
          cropY: calib.cropY * sy,
          scaleX: calib.scaleX * sx,
          scaleY: calib.scaleY * sy,
          gridDx: calib.gridDx ?? 0,
          gridDy: calib.gridDy ?? 0,
          videoWidth: video.videoWidth,
          videoHeight: video.videoHeight,
        };

        // Apply landmark-based tile positions if available
        if (landmarks && landmarks.length > 0 && pipeline) {
          const { defs, lifeNesX, lifeNesY } = applyLandmarks(landmarks, calib.gridDx || 0, calib.gridDy || 0);
          calibration.lifeNesX = lifeNesX;
          calibration.lifeNesY = lifeNesY;
          currentTileDefs = defs;
          pipeline.updateTileDefs(defs);
          console.log(`[${racerId}] Applied ${landmarks.length} landmarks → LIFE at (${lifeNesX + (calib.gridDx||0)}, ${lifeNesY + (calib.gridDy||0)}) canonical`);
        }

        // Update the GPU pipeline with the resolution-adjusted calibration
        if (pipeline) pipeline.updateCalib(calibration);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'calibration', racerId, calibration }));
        }
        console.log(`[${racerId}] Calibration (${calib.videoWidth}x${calib.videoHeight} → ${video.videoWidth}x${video.videoHeight}, scale=${sx.toFixed(2)}x${sy.toFixed(2)}):`, calibration);
        startDetectionLoop();
      }
    : () => video.requestVideoFrameCallback(calibrationFrame);

  if (startOffset !== null && startOffset > 0 && isFinite(startOffset)) {
    video.currentTime = startOffset;
    video.addEventListener('seeked', startFn, { once: true });
  } else {
    startFn();
  }
});

// ── Preview ────────────────────────────────────────────────────────────────
function sendPreview() {
  const canvas = document.getElementById('preview');
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, 320, 240);
  canvas.toBlob(blob => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'previewFrame', racerId, jpeg: base64 }));
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/jpeg', 0.85);
}

function sendDebugFrame() {
  const canvas = document.getElementById('preview');
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, 320, 240);

  // Draw heart tile overlays color-coded by classification
  if (calibration && landmarks && lastHeartTiles) {
    const lm = landmarks.find(l => l.label === 'Hearts');
    if (lm) {
      const vw = video.videoWidth || 1;
      const vh = video.videoHeight || 1;
      const toCanvasX = 320 / vw;
      const toCanvasY = 240 / vh;
      const gdx = calibration.gridDx ?? 0;
      const gdy = calibration.gridDy ?? 0;
      const COLOR_THRESH = 0.08;
      const WHITE_THRESH = 0.08;

      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 8; col++) {
          const ti = row * 8 + col;
          const tile = lastHeartTiles[ti];
          if (!tile) continue;
          const hasColor = tile.colorRatio >= COLOR_THRESH;
          const hasWhite = tile.whiteRatio >= WHITE_THRESH;
          // Classification color: green=full, yellow=half, red=empty container, none=empty slot
          let overlay;
          if (hasColor && !hasWhite) overlay = 'rgba(0, 255, 0, 0.45)';       // full — green
          else if (hasColor && hasWhite) overlay = 'rgba(255, 255, 0, 0.45)';  // half — yellow
          else if (!hasColor && hasWhite) overlay = 'rgba(255, 60, 60, 0.45)'; // empty — red
          else continue; // empty slot — no overlay

          // NES tile coords within the landmark region
          const nesX = lm.x + col * 8;
          const nesY = lm.y + row * 8;
          const streamX = calibration.cropX + (nesX + gdx) * calibration.scaleX;
          const streamY = calibration.cropY + (nesY + gdy) * calibration.scaleY;
          const streamW = 8 * calibration.scaleX;
          const streamH = 8 * calibration.scaleY;
          const cx = streamX * toCanvasX;
          const cy = streamY * toCanvasY;
          const cw = streamW * toCanvasX;
          const ch = streamH * toCanvasY;

          ctx.fillStyle = overlay;
          ctx.fillRect(cx, cy, cw, ch);
          ctx.strokeStyle = overlay.replace('0.45)', '0.9)');
          ctx.lineWidth = 1;
          ctx.strokeRect(cx, cy, cw, ch);

          // Show ratios as tiny label
          ctx.fillStyle = 'white';
          ctx.font = '6px monospace';
          ctx.fillText(`${tile.colorRatio.toFixed(2)}`, cx, cy + ch + 7);
          ctx.fillText(`${tile.whiteRatio.toFixed(2)}`, cx, cy + ch + 14);
        }
      }
    }
  }

  // Draw minimap dot overlay
  if (calibration && landmarks && lastMinimapCells) {
    const lm = landmarks.find(l => l.label === 'Minimap');
    if (lm) {
      const vw = video.videoWidth || 1;
      const vh = video.videoHeight || 1;
      const mx = 320 / vw;
      const my = 240 / vh;
      const gdx = calibration.gridDx ?? 0;
      const gdy = calibration.gridDy ?? 0;
      // Find the dot (highest saturation cell)
      let bestIdx = 0, bestSat = -1;
      for (let i = 0; i < lastMinimapCells.length; i++) {
        if (lastMinimapCells[i] > bestSat) { bestSat = lastMinimapCells[i]; bestIdx = i; }
      }
      if (bestSat >= 20) {
        const dotCol = bestIdx % 16;
        const dotRow = Math.floor(bestIdx / 16);
        const nesX = lm.x + dotCol * 4;
        const nesY = lm.y + dotRow * 4;
        const streamX = calibration.cropX + (nesX + gdx) * calibration.scaleX;
        const streamY = calibration.cropY + (nesY + gdy) * calibration.scaleY;
        const streamW = 4 * calibration.scaleX;
        const streamH = 4 * calibration.scaleY;
        const cx = streamX * mx;
        const cy = streamY * my;
        const cw = streamW * mx;
        const ch = streamH * my;
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.9)';
        ctx.lineWidth = 2;
        ctx.strokeRect(cx, cy, cw, ch);
        ctx.fillStyle = 'white';
        ctx.font = '7px monospace';
        ctx.fillText(`C${dotCol + 1}R${dotRow + 1} s=${bestSat.toFixed(0)}`, cx, cy - 2);
      }
    }
  }

  // Draw LIFE shader sample position (cyan overlay — where red_pass is looking)
  if (calibration) {
    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const mx = 320 / vw;
    const my = 240 / vh;
    const gdx = calibration.gridDx ?? 0;
    const gdy = calibration.gridDy ?? 0;
    const lnx = calibration.lifeNesX ?? (184 - gdx);
    const lny = calibration.lifeNesY ?? (16 - gdy);
    const sx = calibration.cropX + (lnx + gdx) * calibration.scaleX;
    const sy = calibration.cropY + (lny + gdy) * calibration.scaleY;
    const sw = 48 * calibration.scaleX;  // 6 tiles wide
    const sh = 8 * calibration.scaleY;
    ctx.fillStyle = 'rgba(0, 255, 255, 0.4)';
    ctx.fillRect(sx * mx, sy * my, sw * mx, sh * my);
    ctx.strokeStyle = 'cyan';
    ctx.lineWidth = 2;
    ctx.strokeRect(sx * mx, sy * my, sw * mx, sh * my);
    ctx.fillStyle = 'cyan';
    ctx.font = '8px monospace';
    ctx.fillText(`LIFE(${Math.round(lnx+gdx)},${Math.round(lny+gdy)})`, sx * mx, sy * my - 3);
  }

  canvas.toBlob(blob => {
    if (!blob) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'debugFrame', racerId, jpeg: base64 }));
      }
    };
    reader.readAsDataURL(blob);
  }, 'image/jpeg', 0.75);
}

// Stall detection: re-fetch stream URL if no frames for 5s
setInterval(() => {
  if (Date.now() - lastFrameTime > 5000) {
    console.warn('stream stall detected — reloading');
    video.load();
    video.play();
    lastFrameTime = Date.now();
  }
}, 2000);

console.log(`Vision tab started: racerId=${racerId} stream=${streamUrl}`);
