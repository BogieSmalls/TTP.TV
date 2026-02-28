'use strict';

import { scanCalibration } from './calibration.js';
import { GpuContext } from './gpu.js';
import { VisionPipeline } from './pipeline.js';

const params = new URLSearchParams(location.search);
const racerId = params.get('racerId');
const streamUrl = params.get('streamUrl');
const calib = JSON.parse(params.get('calib') || '{}');

const gpu = new GpuContext();
let gpuReady = false;
let pipeline = null;

gpu.init().then(() => {
  pipeline = new VisionPipeline(gpu, calib);
  gpuReady = true;
  console.log('GPU ready, pipeline initialized');
}).catch(e => console.error('GPU init failed:', e));

// ── WebSocket ──────────────────────────────────────────────────────────────
const ws = new WebSocket(`ws://${location.host}/vision-tab-ws?racerId=${racerId}`);
ws.addEventListener('open', () => console.log('WS connected'));
ws.addEventListener('message', (ev) => handleServerMessage(JSON.parse(ev.data)));

function handleServerMessage(msg) {
  if (msg.type === 'requestPreview') sendPreview();
  if (msg.type === 'recalibrate') Object.assign(calib, msg.calib);
}

// ── Video ──────────────────────────────────────────────────────────────────
const video = document.getElementById('video');
video.src = streamUrl;
video.play().catch(e => console.error('video play failed:', e));

let frameCount = 0;
let lastFrameTime = Date.now();

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
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'rawState',
        racerId,
        frameCount,
        ...aggregates,
        hudScores: [],      // populated in Task 7
        roomScores: [],     // populated in Task 13
        floorItems: [],     // populated in Task 14
      }));
    }
  }
  video.requestVideoFrameCallback(onVideoFrame);
}

// ── Calibration phase ─────────────────────────────────────────────────────
const calibCanvas = document.createElement('canvas');
let calibration = null;
let calibFrameCount = 0;

async function calibrationFrame() {
  calibFrameCount++;
  calibCanvas.width = video.videoWidth;
  calibCanvas.height = video.videoHeight;
  const ctx = calibCanvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  const imageData = ctx.getImageData(0, 0, video.videoWidth, video.videoHeight);
  const result = scanCalibration(imageData, video.videoWidth, video.videoHeight);

  if (result) {
    calibration = result;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'calibration', racerId, calibration }));
    }
    console.log(`[${racerId}] Calibration locked (${calibFrameCount} frames):`, result);
    startDetectionLoop();
  } else if (calibFrameCount >= 60) {
    // Fallback: unit scale, no crop — still functional for test streams
    calibration = { cropX: 0, cropY: 0, scaleX: 1, scaleY: 1, gridDx: 1, gridDy: 2,
                    videoWidth: video.videoWidth, videoHeight: video.videoHeight };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'calibration', racerId, calibration }));
    }
    console.warn(`[${racerId}] Calibration fallback after 60 frames`);
    startDetectionLoop();
  } else {
    video.requestVideoFrameCallback(calibrationFrame);
  }
}

function startDetectionLoop() {
  video.requestVideoFrameCallback(onVideoFrame);
}

// Start calibration when video is ready
video.addEventListener('loadeddata', () => {
  video.requestVideoFrameCallback(calibrationFrame);
});

// ── Preview ────────────────────────────────────────────────────────────────
function sendPreview() {
  const canvas = document.getElementById('preview');
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, 320, 240);
  canvas.toBlob(blob => {
    if (!blob) return;
    blob.arrayBuffer().then(buf => {
      if (ws.readyState === WebSocket.OPEN) ws.send(buf);
    });
  }, 'image/jpeg', 0.85);
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
