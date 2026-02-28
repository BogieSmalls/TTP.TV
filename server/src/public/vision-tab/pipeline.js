import { AGGREGATE_SHADER, NCC_SHADER } from './shaders.js';
import { TILE_DEFS, MAX_TEMPLATES } from './tileDefs.js';

export class VisionPipeline {
  constructor(gpu, calib) {
    this.gpu = gpu;
    this.calib = calib;
    this.device = gpu.device;
    this._init();
  }

  _init() {
    const d = this.device;

    // Calibration uniform buffer (8 floats = 32 bytes)
    this.calibBuffer = d.createBuffer({
      size: 8 * 4,
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
    this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear' });

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
  }

  _updateCalib() {
    const c = this.calib;
    const data = new Float32Array([
      c.cropX, c.cropY, c.scaleX, c.scaleY,
      c.gridDx, c.gridDy, c.videoWidth, c.videoHeight,
    ]);
    this.device.queue.writeBuffer(this.calibBuffer, 0, data);
  }

  updateCalib(calib) {
    Object.assign(this.calib, calib);
    this._updateCalib();
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

    // Brightness: game area 256x176 NES pixels, stepped by 4 -> 64x44 threads
    pass.setPipeline(this.brightnessPipeline);
    pass.setBindGroup(0, makeBindGroup(this.brightnessPipeline));
    pass.dispatchWorkgroups(4, 3); // ceil(64/16)=4, ceil(44/16)=3

    // Red ratio: 8x8 tile at LIFE position
    pass.setPipeline(this.redPipeline);
    pass.setBindGroup(0, makeBindGroup(this.redPipeline));
    pass.dispatchWorkgroups(1, 1);

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

    return {
      gameBrightness: raw[0] / 1000,
      redRatioAtLife: raw[1] / 1000,
      goldPixelCount: raw[2],
      hudScores,
    };
  }
}
