import { useRef, useState, useEffect, useCallback } from 'react';

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Props {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  initialCrop?: CropRect;
  onChange: (crop: CropRect) => void;
  /** When true, user draws the gameplay area (256×176 NES) and the HUD is inferred above */
  nesGameplayMode?: boolean;
  /** Called with current landmarks whenever they change (for external persistence) */
  onLandmarksChange?: (landmarks: Landmark[]) => void;
  /** Server-provided landmark positions (overrides localStorage/hardcoded when present) */
  initialLandmarks?: Array<{ label: string; x: number; y: number; w: number; h: number }>;
}

const LANDMARKS_STORAGE_KEY = 'ttp-bulk-crop-landmarks';

// NES frame constants (in NES pixel coords, 256×240 full frame)
const NES_FULL_H = 240;
const NES_HUD_H = 64;
const NES_GAMEPLAY_H = 176;
const NES_W = 256;

// HUD landmark positions (NES pixel coords relative to full frame top-left)
export interface Landmark {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

// Hardcoded fallback positions (NES pixels, 256×240 frame, HUD = top 64px).
const HARDCODED_LANDMARKS: Landmark[] = [
  { label: '-LIFE-', x: 176, y: 0, w: 80, h: 8, color: 'rgba(255, 80, 80, 0.6)' },
  { label: 'Hearts', x: 176, y: 24, w: 64, h: 16, color: 'rgba(255, 80, 80, 0.35)' },
  { label: 'Rupees', x: 96, y: 0, w: 32, h: 8, color: 'rgba(100, 200, 100, 0.35)' },
  { label: 'Keys', x: 96, y: 8, w: 24, h: 8, color: 'rgba(200, 200, 100, 0.3)' },
  { label: 'Bombs', x: 96, y: 16, w: 24, h: 8, color: 'rgba(200, 100, 100, 0.3)' },
  { label: 'B', x: 120, y: 0, w: 24, h: 24, color: 'rgba(100, 255, 100, 0.3)' },
  { label: 'A', x: 144, y: 0, w: 24, h: 24, color: 'rgba(180, 180, 255, 0.3)' },
  { label: 'Minimap', x: 16, y: 24, w: 64, h: 32, color: 'rgba(0, 200, 255, 0.4)' },
  { label: 'LVL', x: 0, y: 8, w: 80, h: 8, color: 'rgba(200, 200, 0, 0.3)' },
];

/** Merge position-only landmark data into the hardcoded list (preserves colors) */
function mergeLandmarkPositions(
  positions: Array<{ label: string; x: number; y: number; w: number; h: number }>,
): Landmark[] {
  return HARDCODED_LANDMARKS.map(hc => {
    const saved = positions.find(s => s.label === hc.label);
    return saved ? { ...hc, x: saved.x, y: saved.y, w: saved.w, h: saved.h } : { ...hc };
  });
}

/** Load saved landmarks from localStorage, falling back to hardcoded */
function loadDefaultLandmarks(): Landmark[] {
  try {
    const stored = localStorage.getItem(LANDMARKS_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Array<{ label: string; x: number; y: number; w: number; h: number }>;
      return mergeLandmarkPositions(parsed);
    }
  } catch { /* ignore parse errors */ }
  return HARDCODED_LANDMARKS.map(lm => ({ ...lm }));
}

/** Save landmark positions to localStorage */
function saveLandmarksToStorage(landmarks: Landmark[]): void {
  try {
    const toStore = landmarks.map(({ label, x, y, w, h }) => ({ label, x, y, w, h }));
    localStorage.setItem(LANDMARKS_STORAGE_KEY, JSON.stringify(toStore));
  } catch { /* ignore quota errors */ }
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | null;

const HANDLE_SIZE = 8;

function getHandleRects(rect: CropRect, scale: number) {
  const hs = HANDLE_SIZE;
  const sx = rect.x * scale;
  const sy = rect.y * scale;
  const sw = rect.w * scale;
  const sh = rect.h * scale;
  return {
    nw: { x: sx - hs / 2, y: sy - hs / 2, w: hs, h: hs },
    n:  { x: sx + sw / 2 - hs / 2, y: sy - hs / 2, w: hs, h: hs },
    ne: { x: sx + sw - hs / 2, y: sy - hs / 2, w: hs, h: hs },
    e:  { x: sx + sw - hs / 2, y: sy + sh / 2 - hs / 2, w: hs, h: hs },
    se: { x: sx + sw - hs / 2, y: sy + sh - hs / 2, w: hs, h: hs },
    s:  { x: sx + sw / 2 - hs / 2, y: sy + sh - hs / 2, w: hs, h: hs },
    sw: { x: sx - hs / 2, y: sy + sh - hs / 2, w: hs, h: hs },
    w:  { x: sx - hs / 2, y: sy + sh / 2 - hs / 2, w: hs, h: hs },
  };
}

function hitTestHandle(mx: number, my: number, rect: CropRect, scale: number): Handle {
  const handles = getHandleRects(rect, scale);
  for (const [key, hr] of Object.entries(handles)) {
    const pad = 4;
    if (mx >= hr.x - pad && mx <= hr.x + hr.w + pad &&
        my >= hr.y - pad && my <= hr.y + hr.h + pad) {
      return key as Handle;
    }
  }
  return null;
}

function hitTestRect(mx: number, my: number, rect: CropRect, scale: number): boolean {
  const sx = rect.x * scale;
  const sy = rect.y * scale;
  const sw = rect.w * scale;
  const sh = rect.h * scale;
  return mx >= sx && mx <= sx + sw && my >= sy && my <= sy + sh;
}

// ─── Snap-to-edge detection ───

const SNAP_RADIUS = 14;
const BLACK_BRIGHTNESS = 30;
const DARK_RATIO_THRESHOLD = 0.65;

interface SnapEdges {
  vertical: number[];
  horizontal: number[];
}

function analyzeSnapEdges(img: HTMLImageElement, width: number, height: number): SnapEdges {
  const offscreen = document.createElement('canvas');
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);

  const step = 2;

  const colBrightness = new Float32Array(width);
  const colDark = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let brightnessSum = 0;
    let darkCount = 0;
    let samples = 0;
    for (let y = 0; y < height; y += step) {
      const idx = (y * width + x) * 4;
      const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      brightnessSum += b;
      if (b < BLACK_BRIGHTNESS) darkCount++;
      samples++;
    }
    colBrightness[x] = brightnessSum / samples;
    colDark[x] = darkCount / samples;
  }

  const verticalSet = new Set<number>();
  for (let x = 1; x < width; x++) {
    const prevDark = colDark[x - 1] > DARK_RATIO_THRESHOLD;
    const currDark = colDark[x] > DARK_RATIO_THRESHOLD;
    if (prevDark && !currDark) verticalSet.add(x);
    if (!prevDark && currDark) verticalSet.add(x - 1);
  }
  const CONTRAST_THRESHOLD = 25;
  for (let x = 1; x < width; x++) {
    const diff = Math.abs(colBrightness[x] - colBrightness[x - 1]);
    if (diff > CONTRAST_THRESHOLD) {
      verticalSet.add(colBrightness[x] > colBrightness[x - 1] ? x : x - 1);
    }
  }

  const rowBrightness = new Float32Array(height);
  const rowDark = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let brightnessSum = 0;
    let darkCount = 0;
    let samples = 0;
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const b = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      brightnessSum += b;
      if (b < BLACK_BRIGHTNESS) darkCount++;
      samples++;
    }
    rowBrightness[y] = brightnessSum / samples;
    rowDark[y] = darkCount / samples;
  }

  const horizontalSet = new Set<number>();
  for (let y = 1; y < height; y++) {
    const prevDark = rowDark[y - 1] > DARK_RATIO_THRESHOLD;
    const currDark = rowDark[y] > DARK_RATIO_THRESHOLD;
    if (prevDark && !currDark) horizontalSet.add(y);
    if (!prevDark && currDark) horizontalSet.add(y - 1);
  }
  for (let y = 1; y < height; y++) {
    const diff = Math.abs(rowBrightness[y] - rowBrightness[y - 1]);
    if (diff > CONTRAST_THRESHOLD) {
      horizontalSet.add(rowBrightness[y] > rowBrightness[y - 1] ? y : y - 1);
    }
  }

  return {
    vertical: [...verticalSet].sort((a, b) => a - b),
    horizontal: [...horizontalSet].sort((a, b) => a - b),
  };
}

function snapValue(val: number, snapPoints: number[], radius: number): number {
  let closest = val;
  let minDist = radius + 1;
  for (const sp of snapPoints) {
    const dist = Math.abs(val - sp);
    if (dist < minDist) {
      minDist = dist;
      closest = sp;
    }
  }
  return minDist <= radius ? closest : val;
}

function snapCropEdges(
  rect: CropRect,
  edges: SnapEdges,
  radius: number,
  which: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean },
): CropRect {
  let left = rect.x;
  let right = rect.x + rect.w;
  let top = rect.y;
  let bottom = rect.y + rect.h;

  if (which.left) left = snapValue(left, edges.vertical, radius);
  if (which.right) right = snapValue(right, edges.vertical, radius);
  if (which.top) top = snapValue(top, edges.horizontal, radius);
  if (which.bottom) bottom = snapValue(bottom, edges.horizontal, radius);

  return { x: left, y: top, w: right - left, h: bottom - top };
}

function clampRect(r: CropRect, imgW: number, imgH: number): CropRect {
  let { x, y, w, h } = r;
  w = Math.max(16, w);
  h = Math.max(16, h);
  x = Math.max(0, Math.min(x, imgW - w));
  y = Math.max(0, Math.min(y, imgH - h));
  w = Math.min(w, imgW - x);
  h = Math.min(h, imgH - y);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

// ─── Helpers for NES coordinate conversion ───

/** Convert canvas-relative mouse pos → NES pixel coords given current crop & scales */
function canvasToNes(
  canvasX: number, canvasY: number,
  crop: CropRect, scale: number,
  psX: number, psY: number, fullFrameY: number,
): { nesX: number; nesY: number } {
  const imgX = canvasX / scale;
  const imgY = canvasY / scale;
  return {
    nesX: (imgX - crop.x) / psX,
    nesY: (imgY - fullFrameY) / psY,
  };
}

export default function CropCanvas({ imageUrl, imageWidth, imageHeight, initialCrop, onChange, nesGameplayMode, onLandmarksChange, initialLandmarks }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const snapEdgesRef = useRef<SnapEdges>({ vertical: [], horizontal: [] });

  const [crop, setCrop] = useState<CropRect>(
    initialCrop ?? { x: 0, y: 0, w: imageWidth, h: imageHeight }
  );
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 450 });
  const [dragging, setDragging] = useState<{
    type: 'draw' | 'move' | 'resize';
    handle?: Handle;
    startMouse: { x: number; y: number };
    startCrop: CropRect;
  } | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);

  // Draggable landmarks (NES pixel coords, initialized from server → localStorage → hardcoded)
  const [landmarks, setLandmarks] = useState<Landmark[]>(() =>
    initialLandmarks ? mergeLandmarkPositions(initialLandmarks) : loadDefaultLandmarks()
  );
  const [draggingLandmark, setDraggingLandmark] = useState<{
    index: number;
    startMouse: { x: number; y: number };
    startX: number;
    startY: number;
  } | null>(null);
  const [resizingLandmark, setResizingLandmark] = useState<{
    index: number;
    corner: 'nw' | 'ne' | 'sw' | 'se';
    startMouse: { x: number; y: number };
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);
  const [selectedLandmark, setSelectedLandmark] = useState<number>(-1);
  const [zoomLevel, setZoomLevel] = useState<1 | 2 | 3>(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });

  const baseScale = Math.min(canvasSize.w / imageWidth, canvasSize.h / imageHeight);
  const scale = baseScale * zoomLevel;

  // Only reset crop when image dimensions change (different racer/resolution),
  // NOT when switching screenshots of the same size — preserves adjustments across screenshots
  const prevDimsRef = useRef({ w: imageWidth, h: imageHeight });
  useEffect(() => {
    const dimsChanged = prevDimsRef.current.w !== imageWidth || prevDimsRef.current.h !== imageHeight;
    prevDimsRef.current = { w: imageWidth, h: imageHeight };
    if (dimsChanged) {
      setCrop(initialCrop ?? { x: 0, y: 0, w: imageWidth, h: imageHeight });
      setLandmarks(initialLandmarks ? mergeLandmarkPositions(initialLandmarks) : loadDefaultLandmarks());
    }
    setSelectedLandmark(-1);
  }, [imageUrl, imageWidth, imageHeight]);

  // Notify parent of landmark changes
  useEffect(() => {
    onLandmarksChange?.(landmarks);
  }, [landmarks, onLandmarksChange]);

  // Load image
  useEffect(() => {
    setImageLoaded(false);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      imgRef.current = img;
      snapEdgesRef.current = analyzeSnapEdges(img, imageWidth, imageHeight);
      setImageLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // Resize canvas to fit container
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        setCanvasSize({ w: e.contentRect.width, h: e.contentRect.height });
      }
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, []);

  // ─── Derived NES scales (used in draw + mouse handlers) ───
  const psX = crop.w > 30 ? crop.w / NES_W : 1;
  const psY = crop.h > 30 ? crop.h / NES_GAMEPLAY_H : 1;
  const hudH = NES_HUD_H * psY;
  const fullFrameY = crop.y - hudH;

  // ─── Keyboard: arrow keys to move/resize selected landmark ───
  useEffect(() => {
    if (!nesGameplayMode || selectedLandmark < 0) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const isArrow = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
      if (!isArrow) {
        if (e.key === 'Escape') { setSelectedLandmark(-1); e.preventDefault(); e.stopPropagation(); }
        return;
      }
      e.preventDefault();
      e.stopPropagation();

      const step = e.ctrlKey ? 8 : 1; // Ctrl = 1 tile (8px), else 1px
      const resize = e.shiftKey;       // Shift = resize, else move

      setLandmarks(prev => {
        const next = [...prev];
        const lm = { ...next[selectedLandmark] };

        if (resize) {
          // Shift+Arrow: resize
          if (e.key === 'ArrowRight') lm.w += step;
          if (e.key === 'ArrowLeft') lm.w = Math.max(4, lm.w - step);
          if (e.key === 'ArrowDown') lm.h += step;
          if (e.key === 'ArrowUp') lm.h = Math.max(4, lm.h - step);

          // Only snap Minimap to image edges
          if (lm.label === 'Minimap') {
            const edges = snapEdgesRef.current;
            if (edges.vertical.length > 0 || edges.horizontal.length > 0) {
              const rightImgX = crop.x + (lm.x + lm.w) * psX;
              const bottomImgY = fullFrameY + (lm.y + lm.h) * psY;
              const snappedRight = snapValue(rightImgX, edges.vertical, SNAP_RADIUS);
              const snappedBottom = snapValue(bottomImgY, edges.horizontal, SNAP_RADIUS);
              if (snappedRight !== rightImgX) lm.w = Math.round((snappedRight - crop.x) / psX - lm.x);
              if (snappedBottom !== bottomImgY) lm.h = Math.round((snappedBottom - fullFrameY) / psY - lm.y);
            }
          }
        } else {
          // Arrow: move
          if (e.key === 'ArrowRight') lm.x += step;
          if (e.key === 'ArrowLeft') lm.x -= step;
          if (e.key === 'ArrowDown') lm.y += step;
          if (e.key === 'ArrowUp') lm.y -= step;

          // Only snap Minimap to image edges
          if (lm.label === 'Minimap') {
            const edges = snapEdgesRef.current;
            if (edges.vertical.length > 0 || edges.horizontal.length > 0) {
              const imgX = crop.x + lm.x * psX;
              const imgY = fullFrameY + lm.y * psY;
              const snappedX = snapValue(imgX, edges.vertical, SNAP_RADIUS);
              const snappedY = snapValue(imgY, edges.horizontal, SNAP_RADIUS);
              if (snappedX !== imgX) lm.x = Math.round((snappedX - crop.x) / psX);
              if (snappedY !== imgY) lm.y = Math.round((snappedY - fullFrameY) / psY);
            }
          }
        }

        next[selectedLandmark] = lm;
        return next;
      });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [nesGameplayMode, selectedLandmark, crop, psX, psY, fullFrameY]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !imageLoaded) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.w * dpr;
    canvas.height = canvasSize.h * dpr;
    ctx.scale(dpr, dpr);

    // Clear
    ctx.fillStyle = '#0f0f1a';
    ctx.fillRect(0, 0, canvasSize.w, canvasSize.h);

    // Draw image centered (with pan offset when zoomed)
    const imgW = imageWidth * scale;
    const imgH = imageHeight * scale;
    const offsetX = (canvasSize.w - imgW) / 2 + panOffset.x;
    const offsetY = (canvasSize.h - imgH) / 2 + panOffset.y;

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.drawImage(img, 0, 0, imgW, imgH);

    // Draw snap guide lines
    const snapEdges = snapEdgesRef.current;
    if (snapEdges.vertical.length > 0 || snapEdges.horizontal.length > 0) {
      ctx.save();
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = 'rgba(0, 200, 255, 0.25)';
      for (const x of snapEdges.vertical) {
        const sx = x * scale;
        ctx.beginPath();
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, imgH);
        ctx.stroke();
      }
      for (const y of snapEdges.horizontal) {
        const sy = y * scale;
        ctx.beginPath();
        ctx.moveTo(0, sy);
        ctx.lineTo(imgW, sy);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Dim outside crop
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    const cx = crop.x * scale;
    const cy = crop.y * scale;
    const cw = crop.w * scale;
    const ch = crop.h * scale;
    ctx.fillRect(0, 0, imgW, cy);
    ctx.fillRect(0, cy + ch, imgW, imgH - cy - ch);
    ctx.fillRect(0, cy, cx, ch);
    ctx.fillRect(cx + cw, cy, imgW - cx - cw, ch);

    // Crop outline
    ctx.strokeStyle = '#D4AF37';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx, cy, cw, ch);

    // Handles
    const handles = getHandleRects(crop, scale);
    ctx.fillStyle = '#D4AF37';
    for (const hr of Object.values(handles)) {
      ctx.fillRect(hr.x, hr.y, hr.w, hr.h);
    }

    // Dimensions label
    ctx.fillStyle = '#D4AF37';
    ctx.font = '11px monospace';
    ctx.fillText(`${crop.w}×${crop.h}`, cx + 4, cy - 6);

    // NES gameplay mode: draw inferred HUD region + draggable landmarks
    if (nesGameplayMode && crop.w > 30 && crop.h > 30) {
      const hudCx = cx;
      const hudCy = fullFrameY * scale;
      const hudCw = cw;
      const hudCh = hudH * scale;

      // HUD outline (dashed cyan)
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(0, 200, 255, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(hudCx, hudCy, hudCw, hudCh);
      ctx.setLineDash([]);

      // Semi-transparent HUD fill
      ctx.fillStyle = 'rgba(0, 200, 255, 0.08)';
      ctx.fillRect(hudCx, hudCy, hudCw, hudCh);

      // "HUD" label
      ctx.fillStyle = 'rgba(0, 200, 255, 0.7)';
      ctx.font = '10px monospace';
      ctx.fillText('HUD (inferred) — drag landmarks to adjust', hudCx + 4, hudCy + 12);

      // "Gameplay" label on the crop
      ctx.fillStyle = 'rgba(212, 175, 55, 0.5)';
      ctx.fillText('Gameplay', cx + 4, cy + 14);

      // Draw landmarks (draggable + selectable)
      for (let i = 0; i < landmarks.length; i++) {
        const lm = landmarks[i];
        const lx = (crop.x + lm.x * psX) * scale;
        const ly = (fullFrameY + lm.y * psY) * scale;
        const lw = lm.w * psX * scale;
        const lh = lm.h * psY * scale;

        const isDragged = draggingLandmark?.index === i;
        const isSelected = selectedLandmark === i;
        const isActive = isDragged || isSelected;

        // Fill
        ctx.fillStyle = isActive ? lm.color.replace(/[\d.]+\)$/, '0.8)') : lm.color;
        ctx.fillRect(lx, ly, lw, lh);

        // Border: selected = dashed white, dragged = solid white
        if (isActive) {
          if (isDragged) {
            ctx.setLineDash([]);
            ctx.strokeStyle = 'white';
          } else {
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
          }
          ctx.lineWidth = 1.5;
          ctx.strokeRect(lx, ly, lw, lh);
          ctx.setLineDash([]);
        }

        // Label + NES coords: selected shows full x,y,w,h
        ctx.fillStyle = isActive ? 'white' : 'rgba(255, 255, 255, 0.8)';
        ctx.font = isActive ? 'bold 9px monospace' : '9px monospace';
        const coordStr = isSelected
          ? `${lm.label} x:${Math.round(lm.x)} y:${Math.round(lm.y)} w:${Math.round(lm.w)} h:${Math.round(lm.h)}`
          : `${lm.label} (${Math.round(lm.x)},${Math.round(lm.y)})`;
        ctx.fillText(coordStr, lx + 2, ly + lh - 2);

        // For selected landmark, draw small resize handles at corners
        if (isSelected && !isDragged) {
          ctx.fillStyle = 'white';
          const hs = 4;
          ctx.fillRect(lx - hs / 2, ly - hs / 2, hs, hs);
          ctx.fillRect(lx + lw - hs / 2, ly - hs / 2, hs, hs);
          ctx.fillRect(lx - hs / 2, ly + lh - hs / 2, hs, hs);
          ctx.fillRect(lx + lw - hs / 2, ly + lh - hs / 2, hs, hs);
        }
      }

      // Divider line between HUD and gameplay
      ctx.strokeStyle = 'rgba(0, 200, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + cw, cy);
      ctx.stroke();
    }

    ctx.restore();
  }, [crop, imageLoaded, canvasSize, scale, imageWidth, imageHeight, nesGameplayMode, landmarks, draggingLandmark, selectedLandmark, psX, psY, hudH, fullFrameY, panOffset]);

  const getMousePos = useCallback((e: React.MouseEvent): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const imgW = imageWidth * scale;
    const imgH = imageHeight * scale;
    const offsetX = (canvasSize.w - imgW) / 2 + panOffset.x;
    const offsetY = (canvasSize.h - imgH) / 2 + panOffset.y;
    return {
      x: e.clientX - rect.left - offsetX,
      y: e.clientY - rect.top - offsetY,
    };
  }, [canvasSize, scale, imageWidth, imageHeight, panOffset]);

  // ─── Hit test landmark resize handles (corners of the selected landmark) ───
  const hitTestLandmarkHandle = useCallback((mx: number, my: number): { index: number; corner: 'nw' | 'ne' | 'sw' | 'se' } | null => {
    if (selectedLandmark < 0 || !nesGameplayMode || crop.w <= 30 || crop.h <= 30) return null;
    const lm = landmarks[selectedLandmark];
    const lx = (crop.x + lm.x * psX) * scale;
    const ly = (fullFrameY + lm.y * psY) * scale;
    const lw = lm.w * psX * scale;
    const lh = lm.h * psY * scale;
    const hitR = 8; // hit radius for corners
    const corners: Array<{ corner: 'nw' | 'ne' | 'sw' | 'se'; cx: number; cy: number }> = [
      { corner: 'nw', cx: lx, cy: ly },
      { corner: 'ne', cx: lx + lw, cy: ly },
      { corner: 'sw', cx: lx, cy: ly + lh },
      { corner: 'se', cx: lx + lw, cy: ly + lh },
    ];
    for (const c of corners) {
      if (Math.abs(mx - c.cx) <= hitR && Math.abs(my - c.cy) <= hitR) {
        return { index: selectedLandmark, corner: c.corner };
      }
    }
    return null;
  }, [selectedLandmark, nesGameplayMode, crop, landmarks, psX, psY, fullFrameY, scale]);

  // ─── Hit test landmarks (in canvas coords relative to image) ───
  const hitTestLandmark = useCallback((mx: number, my: number): number => {
    if (!nesGameplayMode || crop.w <= 30 || crop.h <= 30) return -1;
    // Check in reverse order (last drawn = on top)
    for (let i = landmarks.length - 1; i >= 0; i--) {
      const lm = landmarks[i];
      const lx = (crop.x + lm.x * psX) * scale;
      const ly = (fullFrameY + lm.y * psY) * scale;
      const lw = lm.w * psX * scale;
      const lh = lm.h * psY * scale;
      // Generous hit area (at least 12px)
      const pad = Math.max(0, 6 - lh / 2);
      if (mx >= lx - 2 && mx <= lx + lw + 2 &&
          my >= ly - pad && my <= ly + lh + pad) {
        return i;
      }
    }
    return -1;
  }, [nesGameplayMode, crop, landmarks, psX, psY, fullFrameY, scale]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = getMousePos(e);

    // Check landmark resize handle hit first (corners of selected landmark)
    const lmHandle = hitTestLandmarkHandle(pos.x, pos.y);
    if (lmHandle) {
      const lm = landmarks[lmHandle.index];
      setResizingLandmark({
        index: lmHandle.index,
        corner: lmHandle.corner,
        startMouse: pos,
        startX: lm.x,
        startY: lm.y,
        startW: lm.w,
        startH: lm.h,
      });
      return;
    }

    // Check landmark body hit (only in gameplay mode)
    const lmIdx = hitTestLandmark(pos.x, pos.y);
    if (lmIdx >= 0) {
      setSelectedLandmark(lmIdx);
      setDraggingLandmark({
        index: lmIdx,
        startMouse: pos,
        startX: landmarks[lmIdx].x,
        startY: landmarks[lmIdx].y,
      });
      return;
    }

    // Click outside landmarks deselects
    if (nesGameplayMode) setSelectedLandmark(-1);

    // Check handle hit
    const handle = hitTestHandle(pos.x, pos.y, crop, scale);
    if (handle) {
      setDragging({ type: 'resize', handle, startMouse: pos, startCrop: { ...crop } });
      return;
    }

    // Check rect hit (move)
    if (hitTestRect(pos.x, pos.y, crop, scale)) {
      setDragging({ type: 'move', startMouse: pos, startCrop: { ...crop } });
      return;
    }

    // Draw new rectangle
    const imgX = pos.x / scale;
    const imgY = pos.y / scale;
    if (imgX >= 0 && imgX < imageWidth && imgY >= 0 && imgY < imageHeight) {
      const newCrop = { x: Math.round(imgX), y: Math.round(imgY), w: 1, h: 1 };
      setCrop(newCrop);
      setDragging({ type: 'draw', startMouse: pos, startCrop: newCrop });
    }
  }, [crop, scale, getMousePos, imageWidth, imageHeight, hitTestLandmark, hitTestLandmarkHandle, landmarks, nesGameplayMode]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = getMousePos(e);
    const noSnap = e.ctrlKey; // Hold Ctrl to disable snapping

    // ─── Landmark dragging ───
    if (draggingLandmark) {
      const dx = (pos.x - draggingLandmark.startMouse.x) / scale;
      const dy = (pos.y - draggingLandmark.startMouse.y) / scale;

      // Convert image-pixel delta to NES-pixel delta
      let newNesX = draggingLandmark.startX + dx / psX;
      let newNesY = draggingLandmark.startY + dy / psY;

      // Only snap Minimap to image edges (unless Ctrl held)
      const lmLabel = landmarks[draggingLandmark.index]?.label;
      if (lmLabel === 'Minimap' && !noSnap) {
        const edges = snapEdgesRef.current;
        if (edges.vertical.length > 0 || edges.horizontal.length > 0) {
          const imgX = crop.x + newNesX * psX;
          const imgY = fullFrameY + newNesY * psY;
          const snappedX = snapValue(imgX, edges.vertical, SNAP_RADIUS);
          const snappedY = snapValue(imgY, edges.horizontal, SNAP_RADIUS);
          newNesX = (snappedX - crop.x) / psX;
          newNesY = (snappedY - fullFrameY) / psY;
        }
      }

      setLandmarks(prev => {
        const next = [...prev];
        next[draggingLandmark.index] = {
          ...next[draggingLandmark.index],
          x: Math.round(newNesX),
          y: Math.round(newNesY),
        };
        return next;
      });
      return;
    }

    // ─── Landmark resizing (corner drag) ───
    if (resizingLandmark) {
      const dx = (pos.x - resizingLandmark.startMouse.x) / scale;
      const dy = (pos.y - resizingLandmark.startMouse.y) / scale;
      const dNesX = dx / psX;
      const dNesY = dy / psY;
      const { corner, startX, startY, startW, startH } = resizingLandmark;

      let newX = startX, newY = startY, newW = startW, newH = startH;

      if (corner === 'se') {
        newW = Math.max(4, startW + dNesX);
        newH = Math.max(4, startH + dNesY);
      } else if (corner === 'sw') {
        newX = startX + dNesX;
        newW = Math.max(4, startW - dNesX);
        newH = Math.max(4, startH + dNesY);
      } else if (corner === 'ne') {
        newW = Math.max(4, startW + dNesX);
        newY = startY + dNesY;
        newH = Math.max(4, startH - dNesY);
      } else { // nw
        newX = startX + dNesX;
        newW = Math.max(4, startW - dNesX);
        newY = startY + dNesY;
        newH = Math.max(4, startH - dNesY);
      }

      // Only snap Minimap resize edges (unless Ctrl held)
      const resizeLmLabel = landmarks[resizingLandmark.index]?.label;
      if (resizeLmLabel === 'Minimap' && !noSnap) {
        const edges = snapEdgesRef.current;
        if (edges.vertical.length > 0 || edges.horizontal.length > 0) {
          if (corner.includes('e')) {
            const rightImg = crop.x + (newX + newW) * psX;
            const snapped = snapValue(rightImg, edges.vertical, SNAP_RADIUS);
            if (snapped !== rightImg) newW = (snapped - crop.x) / psX - newX;
          }
          if (corner.includes('w')) {
            const leftImg = crop.x + newX * psX;
            const snapped = snapValue(leftImg, edges.vertical, SNAP_RADIUS);
            if (snapped !== leftImg) { const oldRight = newX + newW; newX = (snapped - crop.x) / psX; newW = oldRight - newX; }
          }
          if (corner.includes('s')) {
            const bottomImg = fullFrameY + (newY + newH) * psY;
            const snapped = snapValue(bottomImg, edges.horizontal, SNAP_RADIUS);
            if (snapped !== bottomImg) newH = (snapped - fullFrameY) / psY - newY;
          }
          if (corner.includes('n')) {
            const topImg = fullFrameY + newY * psY;
            const snapped = snapValue(topImg, edges.horizontal, SNAP_RADIUS);
            if (snapped !== topImg) { const oldBottom = newY + newH; newY = (snapped - fullFrameY) / psY; newH = oldBottom - newY; }
          }
        }
      }

      setLandmarks(prev => {
        const next = [...prev];
        next[resizingLandmark.index] = {
          ...next[resizingLandmark.index],
          x: Math.round(newX),
          y: Math.round(newY),
          w: Math.round(Math.max(4, newW)),
          h: Math.round(Math.max(4, newH)),
        };
        return next;
      });
      return;
    }

    // ─── Crop dragging ───
    if (!dragging) return;

    const dx = (pos.x - dragging.startMouse.x) / scale;
    const dy = (pos.y - dragging.startMouse.y) / scale;
    const sc = dragging.startCrop;

    let newCrop: CropRect;

    if (dragging.type === 'draw') {
      const startX = sc.x;
      const startY = sc.y;
      const endX = startX + dx;
      const endY = startY + dy;
      newCrop = {
        x: Math.min(startX, endX),
        y: Math.min(startY, endY),
        w: Math.abs(endX - startX),
        h: Math.abs(endY - startY),
      };
    } else if (dragging.type === 'move') {
      newCrop = { x: sc.x + dx, y: sc.y + dy, w: sc.w, h: sc.h };
    } else {
      newCrop = { ...sc };
      const h = dragging.handle!;
      if (h.includes('w')) { newCrop.x = sc.x + dx; newCrop.w = sc.w - dx; }
      if (h.includes('e')) { newCrop.w = sc.w + dx; }
      if (h.includes('n')) { newCrop.y = sc.y + dy; newCrop.h = sc.h - dy; }
      if (h.includes('s')) { newCrop.h = sc.h + dy; }
    }

    // Apply edge snapping (unless Ctrl held)
    const edges = snapEdgesRef.current;
    if (!noSnap && (edges.vertical.length > 0 || edges.horizontal.length > 0)) {
      let which: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean };
      if (dragging.type === 'draw') {
        which = { left: true, right: true, top: true, bottom: true };
      } else if (dragging.type === 'move') {
        which = {};
      } else {
        const h = dragging.handle!;
        which = {
          left: h.includes('w'),
          right: h.includes('e'),
          top: h.includes('n'),
          bottom: h.includes('s'),
        };
      }
      newCrop = snapCropEdges(newCrop, edges, SNAP_RADIUS, which);
    }

    const clamped = clampRect(newCrop, imageWidth, imageHeight);
    setCrop(clamped);
  }, [dragging, draggingLandmark, resizingLandmark, getMousePos, scale, imageWidth, imageHeight, crop, psX, psY, fullFrameY]);

  const handleMouseUp = useCallback(() => {
    if (resizingLandmark) {
      setResizingLandmark(null);
      return;
    }
    if (draggingLandmark) {
      setDraggingLandmark(null);
      return;
    }
    if (dragging) {
      onChange(crop);
      setDragging(null);
    }
  }, [dragging, draggingLandmark, resizingLandmark, crop, onChange]);

  // Cursor style
  const getCursor = useCallback((e: React.MouseEvent) => {
    const pos = getMousePos(e);
    // Check landmark resize handles first
    const lmHandle = hitTestLandmarkHandle(pos.x, pos.y);
    if (lmHandle) {
      const cursors: Record<string, string> = {
        nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', se: 'nwse-resize',
      };
      return cursors[lmHandle.corner];
    }
    // Check landmark body
    const hoveredLm = hitTestLandmark(pos.x, pos.y);
    if (hoveredLm >= 0) return hoveredLm === selectedLandmark ? 'grab' : 'pointer';
    const handle = hitTestHandle(pos.x, pos.y, crop, scale);
    if (handle) {
      const cursors: Record<string, string> = {
        nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', se: 'nwse-resize',
        n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize',
      };
      return cursors[handle] || 'default';
    }
    if (hitTestRect(pos.x, pos.y, crop, scale)) return 'move';
    return 'crosshair';
  }, [crop, scale, getMousePos, hitTestLandmark, hitTestLandmarkHandle, selectedLandmark]);

  const [cursor, setCursorStyle] = useState('crosshair');

  // Reset landmarks to defaults
  const resetLandmarks = useCallback(() => {
    setLandmarks(loadDefaultLandmarks());
  }, []);

  // Zoom toggle: cycle 1x → 2x → 3x → 1x, auto-center on HUD when zooming in
  const cycleZoom = useCallback(() => {
    setZoomLevel(prev => {
      const next = prev === 1 ? 2 : prev === 2 ? 3 : 1;
      if (next === 1) {
        setPanOffset({ x: 0, y: 0 });
      } else {
        // Center on the HUD/crop area
        const newScale = baseScale * next;
        const hudTop = fullFrameY * newScale;
        const cropCenterX = (crop.x + crop.w / 2) * newScale;
        setPanOffset({
          x: canvasSize.w / 2 - cropCenterX,
          y: canvasSize.h / 3 - hudTop,
        });
      }
      return next;
    });
  }, [baseScale, fullFrameY, crop, canvasSize]);

  // Wheel to pan when zoomed
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (zoomLevel === 1) return;
    e.preventDefault();
    setPanOffset(prev => ({
      x: prev.x - e.deltaX,
      y: prev.y - e.deltaY,
    }));
  }, [zoomLevel]);

  // Middle-click drag to pan
  const [panning, setPanning] = useState<{ startMouse: { x: number; y: number }; startPan: { x: number; y: number } } | null>(null);

  return (
    <div ref={containerRef} className="w-full h-full min-h-[400px] relative bg-surface rounded overflow-hidden">
      <canvas
        ref={canvasRef}
        style={{ width: canvasSize.w, height: canvasSize.h, cursor: panning ? 'grabbing' : resizingLandmark ? (
          { nw: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', se: 'nwse-resize' }[resizingLandmark.corner]
        ) : draggingLandmark ? 'grabbing' : cursor }}
        onMouseDown={(e) => {
          // Middle-click to pan
          if (e.button === 1 && zoomLevel > 1) {
            e.preventDefault();
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            setPanning({
              startMouse: { x: e.clientX - rect.left, y: e.clientY - rect.top },
              startPan: { ...panOffset },
            });
            return;
          }
          handleMouseDown(e);
        }}
        onMouseMove={(e) => {
          if (panning) {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            setPanOffset({
              x: panning.startPan.x + (mx - panning.startMouse.x),
              y: panning.startPan.y + (my - panning.startMouse.y),
            });
            return;
          }
          handleMouseMove(e);
          if (!dragging && !draggingLandmark && !resizingLandmark) setCursorStyle(getCursor(e));
        }}
        onMouseUp={(e) => {
          if (panning) { setPanning(null); return; }
          handleMouseUp();
        }}
        onMouseLeave={() => {
          if (panning) { setPanning(null); return; }
          handleMouseUp();
        }}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      {/* Coordinate readout */}
      <div className="absolute bottom-2 left-2 bg-black/70 text-xs text-white/70 px-2 py-1 rounded font-mono">
        {nesGameplayMode ? (
          <>
            gameplay: x:{crop.x} y:{crop.y} w:{crop.w} h:{crop.h}
            {' | full: y:'}
            {Math.round(crop.y - crop.h * NES_HUD_H / NES_GAMEPLAY_H)}
            {' h:'}
            {Math.round(crop.h * NES_FULL_H / NES_GAMEPLAY_H)}
            {selectedLandmark >= 0 && landmarks[selectedLandmark] && (
              <span className="text-cyan-300 ml-2">
                | {landmarks[selectedLandmark].label}: x:{Math.round(landmarks[selectedLandmark].x)} y:{Math.round(landmarks[selectedLandmark].y)} w:{Math.round(landmarks[selectedLandmark].w)} h:{Math.round(landmarks[selectedLandmark].h)}
                <span className="text-white/40 ml-1">(arrows: move, shift+arrows: resize, ctrl: 8px step)</span>
              </span>
            )}
          </>
        ) : (
          <>x:{crop.x} y:{crop.y} w:{crop.w} h:{crop.h} ({imageWidth}×{imageHeight})</>
        )}
      </div>
      {/* Top-right controls */}
      <div className="absolute top-2 right-2 flex gap-1.5">
        {/* Zoom toggle */}
        <button
          onClick={cycleZoom}
          className={`bg-black/70 text-xs px-2 py-1 rounded hover:bg-black/90 ${
            zoomLevel > 1 ? 'text-gold' : 'text-white/50 hover:text-white/80'
          }`}
          title="Cycle zoom: 1x → 2x → 3x (scroll to pan when zoomed)"
        >
          {zoomLevel}x
        </button>
        {/* Reset landmarks button (only in gameplay mode) */}
        {nesGameplayMode && (
          <button
            onClick={resetLandmarks}
            className="bg-black/70 text-xs text-white/50 px-2 py-1 rounded hover:text-white/80 hover:bg-black/90"
          >
            Reset Landmarks
          </button>
        )}
      </div>
    </div>
  );
}
