export class GpuContext {
  constructor() {
    this.device = null;
    this.templates = {};     // { '8x8': GPUTexture, '8x16': GPUTexture, ... }
    this.templateMeta = {};  // { '8x8': [{ name, idx }], ... }
  }

  async init() {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('WebGPU not supported');
    this.device = await adapter.requestDevice({
      requiredFeatures: ['timestamp-query'],
    });
    this.device.lost.then(info => {
      console.error('WebGPU device lost:', info.message);
    });
    await this._loadTemplates();
    console.log('WebGPU initialized. Templates loaded:', Object.keys(this.templates));
  }

  async _loadTemplates() {
    const resp = await fetch('/api/vision/templates');
    const groups = await resp.json();

    for (const [groupKey, items] of Object.entries(groups)) {
      const [w, h] = groupKey === '8x8' ? [8, 8] : [8, 16];
      const count = items.length;
      const texture = this.device.createTexture({
        size: [w, h, count],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.templateMeta[groupKey] = [];

      items.forEach((item, idx) => {
        const pixels = item.pixels;
        const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;
        const std = Math.sqrt(pixels.reduce((s, p) => s + (p - mean) ** 2, 0) / pixels.length) || 1;
        const normalized = new Float32Array(pixels.map(p => (p - mean) / std));

        this.device.queue.writeTexture(
          { texture, origin: [0, 0, idx] },
          normalized,
          { bytesPerRow: w * 4, rowsPerImage: h },
          [w, h, 1]
        );
        this.templateMeta[groupKey].push({ name: item.name, idx });
      });

      this.templates[groupKey] = texture;
    }
  }
}
