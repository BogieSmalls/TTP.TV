import { AGGREGATE_SHADER } from './shaders.js';

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
    d.queue.submit([enc.finish()]);

    await this.stagingBuffer.mapAsync(GPUMapMode.READ);
    const raw = new Int32Array(this.stagingBuffer.getMappedRange().slice(0));
    this.stagingBuffer.unmap();

    return {
      gameBrightness: raw[0] / 1000,
      redRatioAtLife: raw[1] / 1000,
      goldPixelCount: raw[2],
    };
  }
}
