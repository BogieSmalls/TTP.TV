import { useState, useEffect, useRef, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Camera, Loader2, Save, Monitor, Gamepad2, Crosshair, X } from 'lucide-react';
import CropCanvas, { type CropRect, type Landmark } from './CropCanvas';
import {
  extractScreenshots,
  createCropProfile,
  updateCropProfile,
  getCropProfiles,
  getDefaultLandmarks,
  autoCropFromExtraction,
} from '../../lib/cropApi';
import type { ScreenshotInfo, LandmarkPosition, AutoCropResult, CropProfile } from '../../lib/cropApi';

// NES frame ratios for gameplay → full crop conversion
const NES_FULL_H = 240;
const NES_HUD_H = 64;
const NES_GAMEPLAY_H = 176;

function gameplayToFullCrop(gp: CropRect): CropRect {
  const vertScale = gp.h / NES_GAMEPLAY_H;
  const hudH = Math.round(NES_HUD_H * vertScale);
  const fullH = Math.round(NES_FULL_H * vertScale);
  return { x: gp.x, y: gp.y - hudH, w: gp.w, h: fullH };
}

function fullToGameplayCrop(full: CropRect): CropRect {
  const vertScale = full.h / NES_FULL_H;
  const hudH = Math.round(NES_HUD_H * vertScale);
  const gameH = Math.round(NES_GAMEPLAY_H * vertScale);
  return { x: full.x, y: full.y + hudH, w: full.w, h: gameH };
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface Props {
  racerProfileId: string;
  onComplete: () => void;
  onCancel: () => void;
  /** Pre-fill VOD URL (e.g., from Twitch channel) */
  initialVodUrl?: string;
}

type Phase = 'url' | 'editor';

export default function CropCreationWizard({ racerProfileId, onComplete, onCancel, initialVodUrl }: Props) {
  const [phase, setPhase] = useState<Phase>('url');
  const [vodUrl, setVodUrl] = useState(initialVodUrl ?? '');
  const [screenshots, setScreenshots] = useState<ScreenshotInfo[]>([]);
  const [extractionId, setExtractionId] = useState<string | null>(null);
  const [selectedScreenshot, setSelectedScreenshot] = useState<ScreenshotInfo | null>(null);
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [cropMode, setCropMode] = useState<'full' | 'gameplay'>('gameplay');
  const [label, setLabel] = useState('');
  const [isDefault, setIsDefault] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [serverLandmarks, setServerLandmarks] = useState<LandmarkPosition[] | null>(null);
  const [autoCropResult, setAutoCropResult] = useState<AutoCropResult | null>(null);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const currentLandmarksRef = useRef<Landmark[]>([]);
  const autoCropAttemptedRef = useRef(false);
  const [existingProfile, setExistingProfile] = useState<CropProfile | null>(null);

  // Fetch existing crop profile + server landmarks on mount
  useEffect(() => {
    getDefaultLandmarks()
      .then(res => { if (res.landmarks) setServerLandmarks(res.landmarks); })
      .catch(() => {});
    getCropProfiles(racerProfileId)
      .then(profiles => {
        const profile = profiles.find(p => p.is_default) || profiles[0];
        if (profile) {
          setExistingProfile(profile);
          if (profile.screenshot_source && !vodUrl) {
            setVodUrl(profile.screenshot_source);
          }
          if (profile.label) setLabel(profile.label);
        }
      })
      .catch(() => {});
  }, [racerProfileId]);

  const extract = useMutation({
    mutationFn: () => extractScreenshots(vodUrl),
    onSuccess: (data) => {
      setScreenshots(data.screenshots);
      setExtractionId(data.extractionId);
      if (data.screenshots.length > 0) {
        setSelectedScreenshot(data.screenshots[0]);
        if (existingProfile) {
          // Pre-populate with existing crop values
          const fullCrop: CropRect = {
            x: existingProfile.crop_x,
            y: existingProfile.crop_y,
            w: existingProfile.crop_w,
            h: existingProfile.crop_h,
          };
          setCrop(cropMode === 'gameplay' ? fullToGameplayCrop(fullCrop) : fullCrop);
          autoCropAttemptedRef.current = true; // skip auto-crop
        } else {
          setCrop({ x: 0, y: 0, w: data.width, h: data.height });
          autoCropAttemptedRef.current = false;
        }
      }
      setPhase('editor');
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  // Auto-crop after screenshots arrive
  useEffect(() => {
    if (phase === 'editor' && extractionId && !autoCropAttemptedRef.current && screenshots.length > 0) {
      autoCropAttemptedRef.current = true;
      setAutoDetecting(true);
      autoCropFromExtraction(extractionId)
        .then(result => {
          setAutoCropResult(result);
          if (result.crop) {
            const fullCrop = result.crop;
            if (cropMode === 'gameplay') {
              setCrop(fullToGameplayCrop(fullCrop));
            } else {
              setCrop(fullCrop);
            }
          }
        })
        .catch(() => {})
        .finally(() => setAutoDetecting(false));
    }
  }, [phase, extractionId, screenshots.length, cropMode]);

  const handleCropModeToggle = useCallback(() => {
    setCropMode(prev => {
      const next = prev === 'gameplay' ? 'full' : 'gameplay';
      if (crop) {
        if (next === 'full' && prev === 'gameplay') {
          setCrop(gameplayToFullCrop(crop));
        } else if (next === 'gameplay' && prev === 'full') {
          setCrop(fullToGameplayCrop(crop));
        }
      }
      return next;
    });
  }, [crop]);

  const save = useMutation({
    mutationFn: () => {
      const finalCrop = cropMode === 'gameplay' && crop ? gameplayToFullCrop(crop) : crop!;
      const landmarks = currentLandmarksRef.current.map(({ label: l, x, y, w, h }) => ({ label: l, x, y, w, h }));
      const cropData = {
        crop_x: finalCrop.x,
        crop_y: finalCrop.y,
        crop_w: finalCrop.w,
        crop_h: finalCrop.h,
        stream_width: selectedScreenshot?.width ?? 1920,
        stream_height: selectedScreenshot?.height ?? 1080,
        grid_offset_dx: autoCropResult?.gridOffset?.dx ?? 0,
        grid_offset_dy: autoCropResult?.gridOffset?.dy ?? 0,
        screenshot_source: vodUrl,
        is_default: isDefault ? 1 : 0,
        confidence: autoCropResult?.confidence ?? null,
      };
      if (existingProfile) {
        return updateCropProfile(existingProfile.id, {
          ...cropData,
          label: label || existingProfile.label || 'Untitled',
          landmarks: landmarks.length > 0 ? landmarks : undefined,
        } as any).then(() => ({ id: existingProfile.id }));
      }
      return createCropProfile({
        ...cropData,
        racer_profile_id: racerProfileId,
        label: label || 'Untitled',
        landmarks: landmarks.length > 0 ? landmarks : undefined,
      });
    },
    onSuccess: () => onComplete(),
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  // Phase 1: URL input
  if (phase === 'url') {
    return (
      <div className="bg-panel rounded-lg border border-white/5 p-5">
        <div className="space-y-4">
          <p className="text-sm text-white/60">
            Enter a Twitch channel (live), VOD URL, or YouTube URL to grab screenshots for crop definition.
          </p>
          <div>
            <label className="block text-xs text-white/40 mb-1">Stream or VOD URL</label>
            <input
              type="text"
              value={vodUrl}
              onChange={e => setVodUrl(e.target.value)}
              placeholder="twitch.tv/username, twitch.tv/videos/..., or youtube.com/..."
              className="w-full bg-surface border border-white/10 rounded px-3 py-2 text-sm focus:border-gold focus:outline-none"
            />
          </div>
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-sm">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => extract.mutate()}
              disabled={!vodUrl || extract.isPending}
              className="flex items-center gap-1.5 px-4 py-2 bg-gold/15 text-gold rounded text-sm font-medium hover:bg-gold/25 transition-colors disabled:opacity-30"
            >
              {extract.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Camera size={14} />
              )}
              {extract.isPending ? 'Extracting...' : 'Extract Screenshots'}
            </button>
            <button
              onClick={onCancel}
              className="px-4 py-2 text-white/40 text-sm hover:text-white/80 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Phase 2: Editor
  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-panel border-b border-white/5 shrink-0">
        <div className="flex items-center gap-3">
          {/* Auto-crop badge */}
          {autoDetecting && (
            <span className="flex items-center gap-1 text-xs text-blue-400">
              <Loader2 size={12} className="animate-spin" /> Auto-detecting...
            </span>
          )}
          {autoCropResult && !autoDetecting && (
            <span className={`flex items-center gap-1 text-xs ${
              autoCropResult.confidence > 0.7 ? 'text-green-400' :
              autoCropResult.confidence > 0.4 ? 'text-yellow-400' : 'text-red-400'
            }`}>
              <Crosshair size={12} />
              Auto-crop: {(autoCropResult.confidence * 100).toFixed(0)}%
              {autoCropResult.hudVerified && ' (HUD verified)'}
            </span>
          )}

          {/* Crop mode toggle */}
          <button
            onClick={handleCropModeToggle}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded border border-white/10 hover:border-white/20 transition-colors"
          >
            {cropMode === 'gameplay' ? <Gamepad2 size={12} /> : <Monitor size={12} />}
            {cropMode === 'gameplay' ? 'Gameplay' : 'Full Frame'}
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1 text-white/40 text-xs hover:text-white/80 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !crop || crop.w < 16 || crop.h < 16}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gold/15 text-gold rounded text-sm font-medium hover:bg-gold/25 transition-colors disabled:opacity-30"
          >
            {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {save.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-red-400 text-xs">
          {error}
        </div>
      )}

      {/* Screenshot thumbnails */}
      {screenshots.length > 1 && (
        <div className="flex gap-1.5 px-4 py-2 overflow-x-auto shrink-0 border-b border-white/5">
          {screenshots.map(s => (
            <button
              key={s.filename}
              onClick={() => setSelectedScreenshot(s)}
              className={`shrink-0 w-24 aspect-video rounded overflow-hidden border transition-colors ${
                selectedScreenshot?.filename === s.filename ? 'border-gold' : 'border-white/10 hover:border-white/20'
              }`}
            >
              <img
                src={s.url}
                alt={`${formatTimestamp(s.timestamp)}`}
                className="w-full h-full object-cover"
              />
            </button>
          ))}
        </div>
      )}

      {/* Canvas */}
      {selectedScreenshot && (
        <div className="flex-1 min-h-0 px-4 py-2">
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
      )}

      {/* Footer bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-t border-white/5 shrink-0">
        <div className="flex-1">
          <input
            type="text"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Label (e.g., Casual Layout)"
            className="w-full bg-surface border border-white/10 rounded px-3 py-1.5 text-sm focus:border-gold focus:outline-none"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-white/60 cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={e => setIsDefault(e.target.checked)}
            className="accent-[#D4AF37]"
          />
          Default
        </label>
        {crop && (
          <div className="text-[10px] font-mono text-white/30 shrink-0">
            {cropMode === 'gameplay' ? (
              <>gp: {crop.x},{crop.y} {crop.w}×{crop.h} → full: {gameplayToFullCrop(crop).x},{gameplayToFullCrop(crop).y} {gameplayToFullCrop(crop).w}×{gameplayToFullCrop(crop).h}</>
            ) : (
              <>crop: {crop.x},{crop.y} {crop.w}×{crop.h}</>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
