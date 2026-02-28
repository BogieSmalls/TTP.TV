'use strict';

const params = new URLSearchParams(location.search);
const racerId = params.get('racerId');
const streamUrl = params.get('streamUrl');
const calib = JSON.parse(params.get('calib') || '{}');

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

function onVideoFrame(now, metadata) {
  lastFrameTime = Date.now();
  frameCount++;
  // Heartbeat every 30 frames
  if (frameCount % 30 === 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'heartbeat', racerId, frameCount }));
  }
  // TODO: dispatch WebGPU compute passes (added in Tasks 6-15)
  video.requestVideoFrameCallback(onVideoFrame);
}

video.requestVideoFrameCallback(onVideoFrame);

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
