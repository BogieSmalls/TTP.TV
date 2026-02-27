import { EventEmitter } from 'node:events';
import { v4 as uuid } from 'uuid';
import type { Kysely } from 'kysely';
import type { Database, CropProfileTable } from '../db/database.js';
import { logger } from '../logger.js';

export interface LandmarkPosition {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CropData {
  cropProfileId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  streamWidth: number;
  streamHeight: number;
  gridOffsetDx: number;
  gridOffsetDy: number;
  landmarks: LandmarkPosition[] | null;
}

export interface CreateCropProfileInput {
  racer_profile_id: string;
  label: string;
  crop_x: number;
  crop_y: number;
  crop_w: number;
  crop_h: number;
  stream_width: number;
  stream_height: number;
  grid_offset_dx?: number;
  grid_offset_dy?: number;
  screenshot_source?: string;
  is_default?: boolean;
  confidence?: number;
  landmarks?: LandmarkPosition[];
  notes?: string;
}

export class CropProfileService extends EventEmitter {
  constructor(private db: Kysely<Database>) { super(); }

  async getByRacerId(racerProfileId: string): Promise<CropProfileTable[]> {
    return this.db.selectFrom('crop_profiles')
      .selectAll()
      .where('racer_profile_id', '=', racerProfileId)
      .orderBy('is_default', 'desc')
      .orderBy('created_at', 'desc')
      .execute();
  }

  async getById(id: string): Promise<CropProfileTable | undefined> {
    return this.db.selectFrom('crop_profiles')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /**
   * Get the effective crop data for a racer.
   * Priority: default crop_profile > inline racer_profiles fields.
   */
  async getDefaultForRacer(racerProfileId: string): Promise<CropData> {
    // 1. Try crop_profiles with is_default=1
    const cropProfile = await this.db.selectFrom('crop_profiles')
      .selectAll()
      .where('racer_profile_id', '=', racerProfileId)
      .where('is_default', '=', 1)
      .executeTakeFirst();

    if (cropProfile) {
      let landmarks: LandmarkPosition[] | null = null;
      if (cropProfile.landmarks_json) {
        try { landmarks = JSON.parse(cropProfile.landmarks_json); } catch { /* ignore */ }
      }
      return {
        cropProfileId: cropProfile.id,
        x: cropProfile.crop_x,
        y: cropProfile.crop_y,
        w: cropProfile.crop_w,
        h: cropProfile.crop_h,
        streamWidth: cropProfile.stream_width,
        streamHeight: cropProfile.stream_height,
        gridOffsetDx: cropProfile.grid_offset_dx,
        gridOffsetDy: cropProfile.grid_offset_dy,
        landmarks,
      };
    }

    // 2. Fallback: try any crop_profile (newest first)
    const anyCrop = await this.db.selectFrom('crop_profiles')
      .selectAll()
      .where('racer_profile_id', '=', racerProfileId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    if (anyCrop) {
      let landmarks: LandmarkPosition[] | null = null;
      if (anyCrop.landmarks_json) {
        try { landmarks = JSON.parse(anyCrop.landmarks_json); } catch { /* ignore */ }
      }
      return {
        cropProfileId: anyCrop.id,
        x: anyCrop.crop_x,
        y: anyCrop.crop_y,
        w: anyCrop.crop_w,
        h: anyCrop.crop_h,
        streamWidth: anyCrop.stream_width,
        streamHeight: anyCrop.stream_height,
        gridOffsetDx: anyCrop.grid_offset_dx,
        gridOffsetDy: anyCrop.grid_offset_dy,
        landmarks,
      };
    }

    // 3. Fallback: inline fields from racer_profiles
    const profile = await this.db.selectFrom('racer_profiles')
      .select(['crop_x', 'crop_y', 'crop_w', 'crop_h', 'stream_width', 'stream_height'])
      .where('id', '=', racerProfileId)
      .executeTakeFirst();

    return {
      cropProfileId: null,
      x: profile?.crop_x ?? 0,
      y: profile?.crop_y ?? 0,
      w: profile?.crop_w ?? 1920,
      h: profile?.crop_h ?? 1080,
      streamWidth: profile?.stream_width ?? 1920,
      streamHeight: profile?.stream_height ?? 1080,
      gridOffsetDx: 0,
      gridOffsetDy: 0,
      landmarks: null,
    };
  }

  async create(input: CreateCropProfileInput): Promise<string> {
    const id = uuid();

    // If setting as default, clear existing defaults for this racer
    if (input.is_default) {
      await this.db.updateTable('crop_profiles')
        .set({ is_default: 0 })
        .where('racer_profile_id', '=', input.racer_profile_id)
        .execute();
    }

    await this.db.insertInto('crop_profiles').values({
      id,
      racer_profile_id: input.racer_profile_id,
      label: input.label,
      crop_x: input.crop_x,
      crop_y: input.crop_y,
      crop_w: input.crop_w,
      crop_h: input.crop_h,
      stream_width: input.stream_width,
      stream_height: input.stream_height,
      grid_offset_dx: input.grid_offset_dx ?? 0,
      grid_offset_dy: input.grid_offset_dy ?? 0,
      screenshot_source: input.screenshot_source ?? null,
      is_default: input.is_default ? 1 : 0,
      confidence: input.confidence ?? null,
      landmarks_json: input.landmarks ? JSON.stringify(input.landmarks) : null,
      notes: input.notes ?? null,
    } as any).execute();

    logger.info(`[crop] Created crop profile "${input.label}" (${id}) for racer ${input.racer_profile_id}`);
    this.emit('cropUpdated', id);
    return id;
  }

  async update(id: string, data: Partial<Omit<CropProfileTable, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    await this.db.updateTable('crop_profiles')
      .set(data)
      .where('id', '=', id)
      .execute();
    this.emit('cropUpdated', id);
  }

  async setDefault(id: string): Promise<void> {
    const cropProfile = await this.getById(id);
    if (!cropProfile) throw new Error(`Crop profile ${id} not found`);

    // Clear existing defaults for this racer
    await this.db.updateTable('crop_profiles')
      .set({ is_default: 0 })
      .where('racer_profile_id', '=', cropProfile.racer_profile_id)
      .execute();

    // Set this one as default
    await this.db.updateTable('crop_profiles')
      .set({ is_default: 1 })
      .where('id', '=', id)
      .execute();

    logger.info(`[crop] Set default crop profile to "${cropProfile.label}" (${id})`);
    this.emit('cropUpdated', id);
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('crop_profiles')
      .where('id', '=', id)
      .execute();
  }

  /**
   * Scale an existing crop profile to a new stream resolution.
   * Proportionally adjusts crop coordinates and landmark positions.
   * Returns a new CropData with reduced confidence.
   */
  scaleProfile(
    source: CropData,
    targetWidth: number,
    targetHeight: number,
  ): CropData {
    if (source.streamWidth === targetWidth && source.streamHeight === targetHeight) {
      return source; // no scaling needed
    }

    const scaleX = targetWidth / source.streamWidth;
    const scaleY = targetHeight / source.streamHeight;

    let scaledLandmarks: LandmarkPosition[] | null = null;
    if (source.landmarks) {
      scaledLandmarks = source.landmarks.map((lm) => ({
        label: lm.label,
        x: Math.round(lm.x * scaleX),
        y: Math.round(lm.y * scaleY),
        w: Math.round(lm.w * scaleX),
        h: Math.round(lm.h * scaleY),
      }));
    }

    return {
      cropProfileId: source.cropProfileId,
      x: Math.round(source.x * scaleX),
      y: Math.round(source.y * scaleY),
      w: Math.round(source.w * scaleX),
      h: Math.round(source.h * scaleY),
      streamWidth: targetWidth,
      streamHeight: targetHeight,
      gridOffsetDx: source.gridOffsetDx,
      gridOffsetDy: source.gridOffsetDy,
      landmarks: scaledLandmarks,
    };
  }

  /**
   * Try to find a crop profile for a racer, scaling if the resolution differs.
   * Returns the scaled profile with reduced confidence, or null if no profile exists.
   */
  async getScaledForRacer(
    racerProfileId: string,
    targetWidth: number,
    targetHeight: number,
  ): Promise<CropData | null> {
    const existing = await this.getDefaultForRacer(racerProfileId);
    if (existing.w === 0 || existing.h === 0) return null; // no real profile

    if (existing.streamWidth === targetWidth && existing.streamHeight === targetHeight) {
      return existing; // exact match
    }

    return this.scaleProfile(existing, targetWidth, targetHeight);
  }

  /** Get the most recently saved landmark positions across all crop profiles */
  async getLatestLandmarks(): Promise<LandmarkPosition[] | null> {
    const row = await this.db.selectFrom('crop_profiles')
      .select('landmarks_json')
      .where('landmarks_json', 'is not', null)
      .orderBy('updated_at', 'desc')
      .executeTakeFirst();

    if (!row?.landmarks_json) return null;
    try {
      return JSON.parse(row.landmarks_json) as LandmarkPosition[];
    } catch {
      return null;
    }
  }
}
