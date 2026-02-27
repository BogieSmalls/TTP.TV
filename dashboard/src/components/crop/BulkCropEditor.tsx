import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, Save, SkipForward, Link, Monitor, Gamepad2, Crosshair } from 'lucide-react';
import CropCanvas, { type CropRect, type Landmark } from './CropCanvas';
import type { OnboardingEntry, ScreenshotInfo, LandmarkPosition, AutoCropResult } from '../../lib/bulkCropApi';
import { extractForRacer, saveBulkCrop, skipRacer, setRacerVod, getDefaultLandmarks, autoCropForRacer } from '../../lib/bulkCropApi';

const LANDMARKS_STORAGE_KEY = 'ttp-bulk-crop-landmarks';

// NES frame ratios for gameplay → full crop conversion
const NES_FULL_H = 240;
const NES_HUD_H = 64;
const NES_GAMEPLAY_H = 176;

/** Convert a gameplay-area crop to the full NES crop (including HUD above).
 *  Uses the gameplay height (not width) to derive HUD height — respects non-square pixels. */
function gameplayToFullCrop(gp: CropRect): CropRect {
  const vertScale = gp.h / NES_GAMEPLAY_H; // stream pixels per NES pixel (vertical)
  const hudH = Math.round(NES_HUD_H * vertScale);
  const fullH = Math.round(NES_FULL_H * vertScale);
  return {
    x: gp.x,
    y: gp.y - hudH,
    w: gp.w,
    h: fullH,
  };
}

/** Convert a full NES frame crop (HUD + gameplay) to gameplay-only coordinates */
function fullToGameplayCrop(full: CropRect): CropRect {
  const vertScale = full.h / NES_FULL_H;
  const hudH = Math.round(NES_HUD_H * vertScale);
  const gameH = Math.round(NES_GAMEPLAY_H * vertScale);
  return {
    x: full.x,
    y: full.y + hudH,
    w: full.w,
    h: gameH,
  };
}

interface Props {
  racer: OnboardingEntry;
  onSaved: () => void;
  onSkipped: () => void;
}

export default function BulkCropEditor({ racer, onSaved, onSkipped }: Props) {
  const [selectedScreenshot, setSelectedScreenshot] = useState<ScreenshotInfo | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualVodUrl, setManualVodUrl] = useState('');
  const [showManualInput, setShowManualInput] = useState(false);
  const [cropMode, setCropMode] = useState<'full' | 'gameplay'>('gameplay');
  const currentLandmarksRef = useRef<Landmark[]>([]);
  const [serverLandmarks, setServerLandmarks] = useState<LandmarkPosition[] | null>(null);
  const [autoCropResult, setAutoCropResult] = useState<AutoCropResult | null>(null);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const autoCropAttemptedRef = useRef<string | null>(null); // tracks racer ID to avoid re-triggering

  // Fetch default landmarks from server on mount
  useEffect(() => {
    getDefaultLandmarks()
      .then(setServerLandmarks)
      .catch(() => { /* fall back to localStorage/hardcoded */ });
  }, []);

  // Reset state when racer changes
  useEffect(() => {
    setSelectedScreenshot(null);
    setCrop(null);
    setError(null);
    setManualVodUrl('');
    setShowManualInput(false);
    setAutoCropResult(null);

    // Auto-select first screenshot if available
    if (racer.screenshots.length > 0) {
      setSelectedScreenshot(racer.screenshots[0]);
    }
  }, [racer.racerProfileId]);

  // Auto-extract if racer has VOD but no screenshots
  useEffect(() => {
    if (racer.status === 'vod_found' && racer.screenshots.length === 0) {
      handleExtract();
    }
  }, [racer.racerProfileId, racer.status]);

  const handleExtract = useCallback(async () => {
    setExtracting(true);
    setError(null);
    try {
      const result = await extractForRacer(racer.racerProfileId);
      if (result.screenshots.length > 0) {
        setSelectedScreenshot(result.screenshots[0]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  }, [racer.racerProfileId]);

  const handleAutoCrop = useCallback(async () => {
    setAutoDetecting(true);
    try {
      const result = await autoCropForRacer(racer.racerProfileId);
      setAutoCropResult(result);
      if (result && result.confidence >= 0.5) {
        // Pre-fill the crop rectangle
        const fullCrop: CropRect = result.crop;
        if (cropMode === 'gameplay') {
          setCrop(fullToGameplayCrop(fullCrop));
        } else {
          setCrop(fullCrop);
        }
      }
    } catch (err) {
      console.warn('Auto-crop failed:', err);
    } finally {
      setAutoDetecting(false);
    }
  }, [racer.racerProfileId, cropMode]);

  // Auto-trigger auto-crop when screenshots become available
  useEffect(() => {
    if (
      racer.status === 'ready' &&
      racer.screenshots.length > 0 &&
      autoCropAttemptedRef.current !== racer.racerProfileId
    ) {
      autoCropAttemptedRef.current = racer.racerProfileId;
      handleAutoCrop();
    }
  }, [racer.racerProfileId, racer.status, racer.screenshots.length, handleAutoCrop]);

  const handleSave = useCallback(async () => {
    if (!crop || !selectedScreenshot) return;
    setSaving(true);
    setError(null);
    try {
      // In gameplay mode, convert the gameplay-area crop to full NES frame crop
      const saveCrop = cropMode === 'gameplay' ? gameplayToFullCrop(crop) : crop;
      // Extract landmark positions (strip color — DB only stores geometry)
      const landmarkPositions = currentLandmarksRef.current.length > 0
        ? currentLandmarksRef.current.map(({ label, x, y, w, h }) => ({ label, x, y, w, h }))
        : undefined;
      await saveBulkCrop(racer.racerProfileId, {
        x: saveCrop.x,
        y: saveCrop.y,
        w: saveCrop.w,
        h: saveCrop.h,
        streamWidth: selectedScreenshot.width,
        streamHeight: selectedScreenshot.height,
        screenshotSource: selectedScreenshot.url,
        landmarks: landmarkPositions,
      });
      // Also persist to localStorage as fast client-side cache
      if (landmarkPositions) {
        try {
          localStorage.setItem(LANDMARKS_STORAGE_KEY, JSON.stringify(landmarkPositions));
        } catch { /* ignore */ }
        // Update server landmarks ref so next racer picks up the latest
        setServerLandmarks(landmarkPositions);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [crop, selectedScreenshot, racer.racerProfileId, onSaved, cropMode]);

  const handleSkip = useCallback(async () => {
    try {
      await skipRacer(racer.racerProfileId);
      onSkipped();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [racer.racerProfileId, onSkipped]);

  const handleManualVod = useCallback(async () => {
    if (!manualVodUrl.trim()) return;
    setError(null);
    try {
      await setRacerVod(racer.racerProfileId, manualVodUrl.trim());
      setShowManualInput(false);
      setManualVodUrl('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [racer.racerProfileId, manualVodUrl]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'Enter' && crop && selectedScreenshot && !saving) {
        e.preventDefault();
        handleSave();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        handleSkip();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [crop, selectedScreenshot, saving, handleSave, handleSkip]);

  const screenshots = racer.screenshots;

  // ─── Loading state ───
  if (extracting || racer.status === 'extracting') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-white/50">
        <Loader2 size={32} className="animate-spin text-gold" />
        <p>Extracting screenshots for {racer.displayName}...</p>
        <p className="text-xs text-white/30">This may take 30-60 seconds</p>
      </div>
    );
  }

  // ─── No VOD state ───
  if (racer.status === 'vod_not_found' || (racer.status === 'pending' && !racer.vodUrl)) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-white/50">
        <p className="text-lg">No VOD found for {racer.displayName}</p>
        <p className="text-sm text-white/30">
          Twitch channel: <span className="text-white/50">{racer.twitchChannel}</span>
          {racer.error && <span className="text-red-400 block mt-1">{racer.error}</span>}
        </p>

        {showManualInput ? (
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={manualVodUrl}
              onChange={(e) => setManualVodUrl(e.target.value)}
              placeholder="https://www.twitch.tv/videos/..."
              className="bg-surface text-sm text-white px-3 py-2 rounded border border-white/10 focus:border-gold/50 focus:outline-none w-96"
              onKeyDown={(e) => e.key === 'Enter' && handleManualVod()}
            />
            <button onClick={handleManualVod} className="bg-gold/20 text-gold px-3 py-2 rounded text-sm hover:bg-gold/30">
              Set VOD
            </button>
          </div>
        ) : (
          <div className="flex gap-3">
            <button
              onClick={() => setShowManualInput(true)}
              className="flex items-center gap-2 bg-white/10 text-white/70 px-4 py-2 rounded text-sm hover:bg-white/15"
            >
              <Link size={14} /> Paste VOD URL
            </button>
            <button
              onClick={handleSkip}
              className="flex items-center gap-2 bg-white/5 text-white/40 px-4 py-2 rounded text-sm hover:bg-white/10"
            >
              <SkipForward size={14} /> Skip
            </button>
          </div>
        )}
      </div>
    );
  }

  // ─── Error state ───
  if (racer.status === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-white/50">
        <p className="text-red-400">Error: {racer.error}</p>
        <div className="flex gap-3">
          <button
            onClick={handleExtract}
            className="bg-gold/20 text-gold px-4 py-2 rounded text-sm hover:bg-gold/30"
          >
            Retry
          </button>
          <button
            onClick={handleSkip}
            className="bg-white/5 text-white/40 px-4 py-2 rounded text-sm hover:bg-white/10"
          >
            Skip
          </button>
        </div>
      </div>
    );
  }

  // ─── Main editor ───
  return (
    <div className="flex flex-col h-full gap-3">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <span className="text-white font-medium">{racer.displayName}</span>
          <span className="text-white/30 text-sm ml-2">({racer.twitchChannel})</span>
          {racer.vodTitle && (
            <span className="text-white/20 text-xs ml-2" title={racer.vodTitle}>
              — {racer.vodTitle.slice(0, 50)}
            </span>
          )}
        </div>
        <div className="flex gap-2 items-center">
          {/* Auto-crop badge */}
          {autoCropResult && (
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                autoCropResult.confidence >= 0.7
                  ? 'bg-green-500/20 text-green-400'
                  : autoCropResult.confidence >= 0.5
                  ? 'bg-yellow-500/20 text-yellow-400'
                  : 'bg-red-500/20 text-red-400'
              }`}
              title={`Method: ${autoCropResult.method}, HUD: ${autoCropResult.hudVerified ? 'yes' : 'no'}`}
            >
              Auto: {Math.round(autoCropResult.confidence * 100)}%
            </span>
          )}
          {/* Auto-detect button */}
          <button
            onClick={handleAutoCrop}
            disabled={autoDetecting || racer.screenshots.length === 0}
            className="flex items-center gap-1 bg-white/5 text-white/50 px-2 py-1.5 rounded text-xs hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Auto-detect NES game region"
          >
            {autoDetecting ? <Loader2 size={12} className="animate-spin" /> : <Crosshair size={12} />}
            Auto
          </button>
          {/* Crop mode toggle */}
          <div className="flex bg-white/5 rounded overflow-hidden mr-2">
            <button
              onClick={() => setCropMode('gameplay')}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors ${
                cropMode === 'gameplay' ? 'bg-gold/20 text-gold' : 'text-white/40 hover:text-white/60'
              }`}
              title="Draw gameplay area only — HUD inferred above"
            >
              <Gamepad2 size={13} /> Gameplay
            </button>
            <button
              onClick={() => setCropMode('full')}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs transition-colors ${
                cropMode === 'full' ? 'bg-gold/20 text-gold' : 'text-white/40 hover:text-white/60'
              }`}
              title="Draw full NES frame (HUD + gameplay)"
            >
              <Monitor size={13} /> Full
            </button>
          </div>
          <button
            onClick={handleSkip}
            className="flex items-center gap-1.5 bg-white/5 text-white/50 px-3 py-1.5 rounded text-sm hover:bg-white/10"
            title="Skip (Esc)"
          >
            <SkipForward size={14} /> Skip
          </button>
          <button
            onClick={handleSave}
            disabled={!crop || !selectedScreenshot || saving}
            className="flex items-center gap-1.5 bg-gold/20 text-gold px-3 py-1.5 rounded text-sm hover:bg-gold/30 disabled:opacity-30 disabled:cursor-not-allowed"
            title="Save & Next (Enter)"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save & Next
          </button>
        </div>
      </div>

      {error && (
        <div className="text-red-400 text-sm bg-red-400/10 px-3 py-2 rounded shrink-0">{error}</div>
      )}

      {/* Screenshot thumbnails */}
      {screenshots.length > 0 && (
        <div className="shrink-0 flex gap-2 overflow-x-auto pb-1">
          {screenshots.map((ss) => (
            <button
              key={ss.filename}
              onClick={() => { setSelectedScreenshot(ss); }}
              className={`shrink-0 rounded overflow-hidden border-2 transition-colors ${
                selectedScreenshot?.filename === ss.filename
                  ? 'border-gold'
                  : 'border-transparent hover:border-white/20'
              }`}
            >
              <img
                src={ss.url}
                alt={`${Math.round(ss.timestamp)}s`}
                className="w-24 h-auto"
                loading="lazy"
              />
              <div className="text-[10px] text-white/40 text-center py-0.5 bg-black/50">
                {formatTimestamp(ss.timestamp)}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* CropCanvas */}
      {selectedScreenshot ? (
        <div className="flex-1 min-h-0">
          <CropCanvas
            imageUrl={selectedScreenshot.url}
            imageWidth={selectedScreenshot.width}
            imageHeight={selectedScreenshot.height}
            initialCrop={crop ?? undefined}
            onChange={setCrop}
            nesGameplayMode={cropMode === 'gameplay'}
            onLandmarksChange={(lm) => { currentLandmarksRef.current = lm; }}
            initialLandmarks={serverLandmarks ?? undefined}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-white/30 text-sm">
          {screenshots.length > 0
            ? 'Select a screenshot above to define the crop region'
            : 'Waiting for screenshots...'}
        </div>
      )}

      {/* Crop readout */}
      {crop && (
        <div className="shrink-0 text-xs text-white/40 font-mono text-center">
          {cropMode === 'gameplay' ? (
            <>
              Gameplay: x={crop.x} y={crop.y} w={crop.w} h={crop.h}
              {' → Full: '}
              {(() => { const f = gameplayToFullCrop(crop); return `x=${f.x} y=${f.y} w=${f.w} h=${f.h}`; })()}
            </>
          ) : (
            <>Crop: x={crop.x} y={crop.y} w={crop.w} h={crop.h}</>
          )}
          {selectedScreenshot && ` (${selectedScreenshot.width}×${selectedScreenshot.height})`}
        </div>
      )}
    </div>
  );
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
