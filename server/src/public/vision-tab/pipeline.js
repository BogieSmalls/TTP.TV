import { AGGREGATE_SHADER, NCC_SHADER, ROOM_SHADER, FLOOR_ITEM_SHADER } from './shaders.js';
import { TILE_DEFS, MAX_TEMPLATES } from './tileDefs.js';
import { DEFAULT_LIFE_NES_X, DEFAULT_LIFE_NES_Y } from './tileGrid.js';

export class VisionPipeline {
  constructor(gpu, calib) {
    this.gpu = gpu;
    this.calib = calib;
    this.device = gpu.device;
    this._init();
  }

  _init() {
    const d = this.device;

    // Calibration uniform buffer (12 floats = 48 bytes; WGSL struct alignment rounds to 16-byte)
    // Fields: crop_x, crop_y, scale_x, scale_y, grid_dx, grid_dy, video_w, video_h, life_nes_x, life_nes_y, pad, pad
    this.calibBuffer = d.createBuffer({
      size: 12 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._updateCalib();

    // Result storage buffer (3 atomics = 3 i32 = 12 bytes)
    this.resultBuffer = d.createBuffer({
      size: 3 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    // Staging buffer for CPU readback
    this.stagingBuffer = d.createBuffer({
      size: 3 * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Sampler for texture_external sampling
    this.sampler = d.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });

    // Compile shader module once
    const aggModule = d.createShaderModule({ code: AGGREGATE_SHADER });

    this.brightnessPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: aggModule, entryPoint: 'brightness_pass' },
    });
    this.redPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: aggModule, entryPoint: 'red_pass' },
    });
    this.goldPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: aggModule, entryPoint: 'gold_pass' },
    });

    // Guard: NCC pipeline requires both template texture groups to be loaded
    if (!this.gpu.templates['8x8'] || !this.gpu.templates['8x16']) {
      console.warn('NCC pipeline disabled: missing 8x8 or 8x16 template group');
      this.nccPipeline = null;
      this.nccResultSize = 0;
      return;
    }

    // NCC pipeline (Pass 1)
    const nccModule = d.createShaderModule({ code: NCC_SHADER });
    this.nccPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: nccModule, entryPoint: 'ncc_main' },
    });

    // Tile definitions buffer — CRITICAL: use DataView to write mixed f32/u32 types
    // WGSL TileDef struct: nes_x(f32), nes_y(f32), width(u32), height(u32), tmpl_offset(u32), tmpl_count(u32)
    // = 6 fields x 4 bytes = 24 bytes per tile (no WGSL padding since all fields are 4-byte aligned)
    const tileStride = 24; // bytes per TileDef
    const tileBuf = new ArrayBuffer(TILE_DEFS.length * tileStride);
    const view = new DataView(tileBuf);
    TILE_DEFS.forEach((def, i) => {
      const off = i * tileStride;
      view.setFloat32(off + 0,  def.nesX, true);                         // nes_x: f32
      view.setFloat32(off + 4,  def.nesY, true);                         // nes_y: f32
      view.setUint32( off + 8,  parseInt(def.size.split('x')[0]), true); // width: u32
      view.setUint32( off + 12, def.size === '8x8' ? 8 : 16, true);     // height: u32
      const meta = this.gpu.templateMeta[def.templateGroup] || [];
      view.setUint32( off + 16, 0, true);             // tmpl_offset: u32 (always 0, each group is its own texture array)
      view.setUint32( off + 20, meta.length, true);   // tmpl_count: u32
    });
    this.tileDefsBuffer = d.createBuffer({
      size: tileBuf.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    d.queue.writeBuffer(this.tileDefsBuffer, 0, tileBuf);

    // NCC result buffer: one f32 per (tile x MAX_TEMPLATES)
    const nccResultSize = TILE_DEFS.length * MAX_TEMPLATES * 4;
    this.nccResultSize = nccResultSize;
    this.nccResultBuffer = d.createBuffer({
      size: nccResultSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.nccStagingBuffer = d.createBuffer({
      size: nccResultSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // Pass 2: Room matching — scores buffer allocated here; pipeline created in _initRoomPipeline()
    const ROOM_COUNT = 128;
    this.roomScoresBuffer = d.createBuffer({
      size: ROOM_COUNT * 4,  // 128 f32 scores
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    this.roomStagingBuffer = d.createBuffer({
      size: ROOM_COUNT * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    // Room templates texture and pipeline set later via _initRoomPipeline()
    this.roomPipeline = null;
    this.roomTemplatesTexture = null;
    this.roomCalibBuffer = null;

    // Pass 3: Floor item sliding window — results buffer (37 templates × 12 bytes each)
    // 3 atomics per result (score i32, px i32, py i32) = 12 bytes per template
    const FLOOR_ITEM_COUNT = 37;
    this.floorItemResultsBuffer = d.createBuffer({
      size: FLOOR_ITEM_COUNT * 3 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.floorItemStagingBuffer = d.createBuffer({
      size: FLOOR_ITEM_COUNT * 3 * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    // Pass 3 pipeline and drop templates set later via _initFloorItemPipeline()
    this.floorItemPipeline = null;
    this.dropTemplatesTexture = null;
    this.floorItemCalibBuffer = null;
    this._floorItemCount = FLOOR_ITEM_COUNT;
  }

  /** Called by gpu.js after room templates are fetched from /api/vision/room-templates. */
  _initRoomPipeline(roomTemplates) {
    if (!roomTemplates || roomTemplates.length === 0) return;
    const d = this.device;
    const ROOM_COUNT = roomTemplates.length;
    const W = 64, H = 44;

    // Upload room template pixels as a 2D texture array (one layer per room)
    this.roomTemplatesTexture = d.createTexture({
      size: [W, H, ROOM_COUNT],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    for (let i = 0; i < ROOM_COUNT; i++) {
      const pixels = roomTemplates[i].pixels; // Float32 luma values, length W*H
      const data = new Float32Array(pixels);
      d.queue.writeTexture(
        { texture: this.roomTemplatesTexture, origin: [0, 0, i] },
        data,
        { bytesPerRow: W * 4, rowsPerImage: H },
        [W, H, 1],
      );
    }

    // Room calibration uniform: 6 floats = 24 bytes
    this.roomCalibBuffer = d.createBuffer({
      size: 6 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Compile ROOM_SHADER and create compute pipeline
    const roomModule = d.createShaderModule({ code: ROOM_SHADER });
    this.roomPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: roomModule, entryPoint: 'room_match' },
    });
  }

  /** Called by gpu.js after drop templates are fetched from /api/vision/drop-templates. */
  _initFloorItemPipeline(dropTemplates) {
    if (!dropTemplates || dropTemplates.length === 0) return;
    const d = this.device;
    const ITEM_COUNT = dropTemplates.length;
    const W = 8, H = 16;

    // Upload drop template pixels as a 2D texture array (one layer per template)
    this.dropTemplatesTexture = d.createTexture({
      size: [W, H, ITEM_COUNT],
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    for (let i = 0; i < ITEM_COUNT; i++) {
      const pixels = dropTemplates[i].pixels; // Float32 luma values, length W*H (128)
      const data = new Float32Array(pixels);
      d.queue.writeTexture(
        { texture: this.dropTemplatesTexture, origin: [0, 0, i] },
        data,
        { bytesPerRow: W * 4, rowsPerImage: H },
        [W, H, 1],
      );
    }

    // Floor item calibration uniform: 6 floats = 24 bytes (same layout as roomCalibBuffer)
    this.floorItemCalibBuffer = d.createBuffer({
      size: 6 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Compile FLOOR_ITEM_SHADER and create compute pipeline
    const floorItemModule = d.createShaderModule({ code: FLOOR_ITEM_SHADER });
    this.floorItemPipeline = d.createComputePipeline({
      layout: 'auto',
      compute: { module: floorItemModule, entryPoint: 'floor_item_scan' },
    });
  }

  /** Update floor item calibration uniform (called each frame if floor item pipeline is active). */
  _updateFloorItemCalib(calib) {
    if (!this.floorItemCalibBuffer) return;
    const data = new Float32Array([
      calib.scale_x, calib.scale_y,
      calib.offset_x, calib.offset_y,
      calib.video_w, calib.video_h,
    ]);
    this.device.queue.writeBuffer(this.floorItemCalibBuffer, 0, data);
  }

  /** Update room calibration uniform (called each frame if room pipeline is active). */
  _updateRoomCalib(calib) {
    if (!this.roomCalibBuffer) return;
    const data = new Float32Array([
      calib.scale_x, calib.scale_y,
      calib.offset_x, calib.offset_y,
      calib.video_w, calib.video_h,
    ]);
    this.device.queue.writeBuffer(this.roomCalibBuffer, 0, data);
  }

  _updateCalib() {
    const c = this.calib;
    // life_nes_x/y default to standard NES LIFE position (col 24, row 4) minus grid offset,
    // so that nes_to_uv(life_nes_x, life_nes_y) + gridDx/gridDy hits the correct spot.
    const lifeX = c.lifeNesX ?? (DEFAULT_LIFE_NES_X - (c.gridDx || 0));
    const lifeY = c.lifeNesY ?? (DEFAULT_LIFE_NES_Y - (c.gridDy || 0));
    const data = new Float32Array([
      c.cropX, c.cropY, c.scaleX, c.scaleY,
      c.gridDx ?? 0, c.gridDy ?? 0, c.videoWidth, c.videoHeight,
      lifeX, lifeY, 0, 0,  // pad to 12 floats for 16-byte alignment
    ]);
    this.device.queue.writeBuffer(this.calibBuffer, 0, data);
  }

  /** Update tile definitions buffer with new NES positions (from landmarks). */
  updateTileDefs(updatedDefs) {
    if (!this.tileDefsBuffer) return;
    const tileStride = 24;
    const tileBuf = new ArrayBuffer(updatedDefs.length * tileStride);
    const view = new DataView(tileBuf);
    updatedDefs.forEach((def, i) => {
      const off = i * tileStride;
      view.setFloat32(off + 0,  def.nesX, true);
      view.setFloat32(off + 4,  def.nesY, true);
      view.setUint32( off + 8,  parseInt(def.size.split('x')[0]), true);
      view.setUint32( off + 12, def.size === '8x8' ? 8 : 16, true);
      const meta = this.gpu.templateMeta[def.templateGroup] || [];
      view.setUint32( off + 16, 0, true);
      view.setUint32( off + 20, meta.length, true);
    });
    this.device.queue.writeBuffer(this.tileDefsBuffer, 0, tileBuf);
  }

  updateCalib(calib) {
    Object.assign(this.calib, calib);
    this._updateCalib();
    // Propagate to room/floor item calibration buffers
    this._updateRoomCalib({
      scale_x: this.calib.scaleX, scale_y: this.calib.scaleY,
      offset_x: this.calib.cropX,  offset_y: this.calib.cropY,
      video_w: this.calib.videoWidth, video_h: this.calib.videoHeight,
    });
    this._updateFloorItemCalib({
      scale_x: this.calib.scaleX, scale_y: this.calib.scaleY,
      offset_x: this.calib.cropX,  offset_y: this.calib.cropY,
      video_w: this.calib.videoWidth, video_h: this.calib.videoHeight,
    });
  }

  async processFrame(video) {
    const d = this.device;
    const externalTexture = d.importExternalTexture({ source: video });

    // Reset result buffer to zero before dispatch
    d.queue.writeBuffer(this.resultBuffer, 0, new Int32Array([0, 0, 0]).buffer);

    const enc = d.createCommandEncoder();

    // Bind groups must be created fresh each frame — externalTexture is per-frame
    const makeBindGroup = (pipeline) => d.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: externalTexture },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: { buffer: this.calibBuffer } },
        { binding: 3, resource: { buffer: this.resultBuffer } },
      ],
    });

    const pass = enc.beginComputePass();

    // Only dispatch NCC if pipeline is available
    if (this.nccPipeline) {
      // Pass 1: NCC — dispatch before aggregate passes
      const nccBindGroup = d.createBindGroup({
        layout: this.nccPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: externalTexture },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.gpu.templates['8x8'].createView() },
          { binding: 3, resource: this.gpu.templates['8x16'].createView() },
          { binding: 4, resource: { buffer: this.tileDefsBuffer } },
          { binding: 5, resource: { buffer: this.calibBuffer } },
          { binding: 6, resource: { buffer: this.nccResultBuffer } },
        ],
      });
      pass.setPipeline(this.nccPipeline);
      pass.setBindGroup(0, nccBindGroup);
      // Dispatch: x = tile count, y = MAX_TEMPLATES (workgroups where tmpl_idx >= tmpl_count return early)
      pass.dispatchWorkgroups(TILE_DEFS.length, MAX_TEMPLATES);
    }

    // Pass 2: Room matching — dispatched when roomTemplatesTexture is loaded
    // See _initRoomPipeline() called after room templates are fetched
    if (this.roomPipeline && this.roomTemplatesTexture) {
      const roomBindGroup = d.createBindGroup({
        layout: this.roomPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: externalTexture },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.roomTemplatesTexture.createView({ dimension: '2d-array' }) },
          { binding: 3, resource: { buffer: this.roomCalibBuffer } },
          { binding: 4, resource: { buffer: this.roomScoresBuffer } },
        ],
      });
      pass.setPipeline(this.roomPipeline);
      pass.setBindGroup(0, roomBindGroup);
      // One workgroup per room (x=room index), 64 threads per workgroup (one per column)
      pass.dispatchWorkgroups(128);
    }

    // Pass 3: Floor item sliding window — dispatched when dropTemplatesTexture is loaded
    // See _initFloorItemPipeline() called after drop templates are fetched
    if (this.floorItemPipeline && this.dropTemplatesTexture) {
      // Reset floor item results to zero before dispatch
      d.queue.writeBuffer(this.floorItemResultsBuffer, 0,
        new Int32Array(this._floorItemCount * 3).fill(0).buffer);
      const floorBindGroup = d.createBindGroup({
        layout: this.floorItemPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: externalTexture },
          { binding: 1, resource: this.sampler },
          { binding: 2, resource: this.dropTemplatesTexture.createView({ dimension: '2d-array' }) },
          { binding: 3, resource: { buffer: this.floorItemCalibBuffer } },
          { binding: 4, resource: { buffer: this.floorItemResultsBuffer } },
        ],
      });
      pass.setPipeline(this.floorItemPipeline);
      pass.setBindGroup(0, floorBindGroup);
      // Dispatch: x=scan_x positions (ceil(256/2)=128), y=scan_y positions (ceil(176/2)=88), z=template count
      pass.dispatchWorkgroups(128, 88, this._floorItemCount);
    }

    // Brightness: game area 256x176 NES pixels, stepped by 4 -> 64x44 threads
    pass.setPipeline(this.brightnessPipeline);
    pass.setBindGroup(0, makeBindGroup(this.brightnessPipeline));
    pass.dispatchWorkgroups(4, 3); // ceil(64/16)=4, ceil(44/16)=3

    // Bright pixels: full "-LIFE-" text (6 tiles = 48x8, dispatched as 6 workgroups of 8x8)
    pass.setPipeline(this.redPipeline);
    pass.setBindGroup(0, makeBindGroup(this.redPipeline));
    pass.dispatchWorkgroups(6, 1);

    // Gold pixels: triforce region ~85x100 NES pixels
    pass.setPipeline(this.goldPipeline);
    pass.setBindGroup(0, makeBindGroup(this.goldPipeline));
    pass.dispatchWorkgroups(6, 7); // ceil(85/16)=6, ceil(100/16)=7

    pass.end();

    // Readback to CPU
    enc.copyBufferToBuffer(this.resultBuffer, 0, this.stagingBuffer, 0, 12);
    if (this.nccPipeline) {
      enc.copyBufferToBuffer(this.nccResultBuffer, 0, this.nccStagingBuffer, 0, this.nccResultSize);
    }
    if (this.roomPipeline && this.roomTemplatesTexture) {
      enc.copyBufferToBuffer(this.roomScoresBuffer, 0, this.roomStagingBuffer, 0, 128 * 4);
    }
    if (this.floorItemPipeline && this.dropTemplatesTexture) {
      enc.copyBufferToBuffer(this.floorItemResultsBuffer, 0, this.floorItemStagingBuffer, 0, this._floorItemCount * 3 * 4);
    }
    d.queue.submit([enc.finish()]);

    await this.stagingBuffer.mapAsync(GPUMapMode.READ);
    const raw = new Int32Array(this.stagingBuffer.getMappedRange().slice(0));
    this.stagingBuffer.unmap();

    // NCC readback
    let hudScores = [];
    if (this.nccPipeline) {
      await this.nccStagingBuffer.mapAsync(GPUMapMode.READ);
      const nccRaw = new Float32Array(this.nccStagingBuffer.getMappedRange(0, this.nccResultSize).slice(0));
      this.nccStagingBuffer.unmap();
      hudScores = Array.from(nccRaw);
    }

    // Room scores readback
    let roomScores = [];
    if (this.roomPipeline && this.roomTemplatesTexture) {
      await this.roomStagingBuffer.mapAsync(GPUMapMode.READ);
      const roomRaw = new Float32Array(this.roomStagingBuffer.getMappedRange(0, 128 * 4).slice(0));
      this.roomStagingBuffer.unmap();
      roomScores = Array.from(roomRaw);
    }

    // Floor item results readback: each result is [score_i32, px_i32, py_i32]
    let floorItems = [];
    if (this.floorItemPipeline && this.dropTemplatesTexture) {
      await this.floorItemStagingBuffer.mapAsync(GPUMapMode.READ);
      const floorRaw = new Int32Array(this.floorItemStagingBuffer.getMappedRange(0, this._floorItemCount * 3 * 4).slice(0));
      this.floorItemStagingBuffer.unmap();
      for (let i = 0; i < this._floorItemCount; i++) {
        floorItems.push({
          score: floorRaw[i * 3 + 0] / 10000,
          px: floorRaw[i * 3 + 1],
          py: floorRaw[i * 3 + 2],
        });
      }
    }

    // Brightness: sum of (luma * 1000) for 2816 sampled pixels (64×44, game area stepped by 4).
    // Normalize to mean brightness on 0-255 scale: sum / 1000 / 2816 * 255.
    // Red: count of red pixels (each contributes 1000), divide by 1000.
    return {
      gameBrightness: raw[0] / 1000 / 2816 * 255,
      redRatioAtLife: raw[1] / 1000,
      goldPixelCount: raw[2],
      hudScores,
      roomScores,
      floorItems,
    };
  }
}
