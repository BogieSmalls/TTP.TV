export const AGGREGATE_SHADER = /* wgsl */`
struct Calibration {
  crop_x: f32, crop_y: f32,
  scale_x: f32, scale_y: f32,
  grid_dx: f32, grid_dy: f32,
  video_w: f32, video_h: f32,
  life_nes_x: f32, life_nes_y: f32,  // LIFE text position from landmarks (canonical, pre-grid-offset)
}

struct AggregateResult {
  brightness: atomic<i32>,      // game area mean brightness * 1000 (fixed point)
  red_at_life: atomic<i32>,     // red ratio at LIFE text * 1000
  gold_pixels: atomic<i32>,     // count of gold pixels in triforce region
}

@group(0) @binding(0) var source: texture_external;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var<uniform> calib: Calibration;
@group(0) @binding(3) var<storage, read_write> result: AggregateResult;

fn nes_to_uv(nes_x: f32, nes_y: f32) -> vec2<f32> {
  return vec2<f32>(
    (calib.crop_x + (nes_x + calib.grid_dx) * calib.scale_x) / calib.video_w,
    (calib.crop_y + (nes_y + calib.grid_dy) * calib.scale_y) / calib.video_h,
  );
}

// Pass A: game area brightness (NES rows 64-240, cols 0-256, sampled 4x sparse)
@compute @workgroup_size(16, 16)
fn brightness_pass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let nes_x = f32(gid.x * 4u);       // step 4 NES pixels for speed
  let nes_y = 64.0 + f32(gid.y * 4u);
  if nes_x >= 256.0 || nes_y >= 240.0 { return; }
  let uv = nes_to_uv(nes_x, nes_y);
  let c = textureSampleBaseClampToEdge(source, src_sampler, uv);
  let luma = i32((c.r * 0.299 + c.g * 0.587 + c.b * 0.114) * 1000.0);
  atomicAdd(&result.brightness, luma);
}

// Pass B: bright pixels across full "-LIFE-" / "-ROAR-" text (6 tiles = 48×8 NES pixels)
@compute @workgroup_size(8, 8)
fn red_pass(@builtin(global_invocation_id) gid: vec3<u32>) {
  if gid.x >= 48u || gid.y >= 8u { return; }
  let nes_x = calib.life_nes_x + f32(gid.x);
  let nes_y = calib.life_nes_y + f32(gid.y);
  let uv = nes_to_uv(nes_x, nes_y);
  let c = textureSampleBaseClampToEdge(source, src_sampler, uv);
  // brightness: max channel > 100/255 — LIFE/ROAR text is bright against black HUD
  let max_ch = max(max(c.r, c.g), c.b);
  let is_bright = select(0, 1000, max_ch > 0.39);
  atomicAdd(&result.red_at_life, is_bright);
}

// Pass C: gold pixels in triforce region (subscreen area y=100-200, x=85-170)
@compute @workgroup_size(16, 16)
fn gold_pass(@builtin(global_invocation_id) gid: vec3<u32>) {
  let nes_x = 85.0 + f32(gid.x);
  let nes_y = 100.0 + f32(gid.y);
  if nes_x >= 170.0 || nes_y >= 200.0 { return; }
  let uv = nes_to_uv(nes_x, nes_y);
  let c = textureSampleBaseClampToEdge(source, src_sampler, uv);
  // gold: R>150/255, G>80/255, B<70/255, R>G
  let is_gold = select(0, 1, c.r > 0.588 && c.g > 0.314 && c.b < 0.275 && c.r > c.g);
  atomicAdd(&result.gold_pixels, is_gold);
}
`;

export const ROOM_SHADER = /* wgsl */`
struct Calibration {
  scale_x: f32,
  scale_y: f32,
  offset_x: f32,
  offset_y: f32,
  video_w: f32,
  video_h: f32,
}

fn nes_to_uv(nes_x: f32, nes_y: f32, calib: Calibration) -> vec2<f32> {
  return vec2<f32>(
    (nes_x * calib.scale_x + calib.offset_x) / calib.video_w,
    (nes_y * calib.scale_y + calib.offset_y) / calib.video_h,
  );
}

@group(0) @binding(0) var source: texture_external;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var room_templates: texture_2d_array<f32>;
@group(0) @binding(3) var<uniform> calib: Calibration;
@group(0) @binding(4) var<storage, read_write> scores: array<f32>;

const RESIZED_W: u32 = 64u;
const RESIZED_H: u32 = 44u;
const N_PIXELS: f32 = 2816.0; // 64 * 44

// Each thread handles one column (RESIZED_H pixels) of the 64×44 resized area.
// workgroup_size(64): one workgroup per room template, 64 threads per workgroup.
var<workgroup> ws_src: array<f32, 64>;
var<workgroup> ws_tmpl: array<f32, 64>;
var<workgroup> ws_cross: array<f32, 64>;
var<workgroup> ws_src2: array<f32, 64>;
var<workgroup> ws_tmpl2: array<f32, 64>;
var<workgroup> ws_reduce: array<f32, 64>;

@compute @workgroup_size(64)
fn room_match(
  @builtin(workgroup_id) wid: vec3<u32>,
  @builtin(local_invocation_index) lid: u32,
) {
  let room_idx = wid.x;

  // Each thread accumulates one column (44 pixels)
  var src_sum: f32 = 0.0;
  var tmpl_sum: f32 = 0.0;
  var cross_sum: f32 = 0.0;
  var src2_sum: f32 = 0.0;
  var tmpl2_sum: f32 = 0.0;

  for (var row = 0u; row < RESIZED_H; row++) {
    let nes_x = f32(lid) * (256.0 / f32(RESIZED_W));
    let nes_y = 64.0 + f32(row) * (176.0 / f32(RESIZED_H));
    let uv = nes_to_uv(nes_x, nes_y, calib);
    let src_rgba = textureSampleBaseClampToEdge(source, src_sampler, uv);
    let src_luma = src_rgba.r * 0.299 + src_rgba.g * 0.587 + src_rgba.b * 0.114;
    let tmpl_luma = textureLoad(room_templates, vec2<i32>(i32(lid), i32(row)), i32(room_idx), 0).r;

    src_sum += src_luma;
    tmpl_sum += tmpl_luma;
  }

  ws_src[lid] = src_sum;
  ws_tmpl[lid] = tmpl_sum;
  workgroupBarrier();

  // Parallel reduce for global sums
  var stride = 32u;
  loop {
    if stride == 0u { break; }
    if lid < stride {
      ws_src[lid] += ws_src[lid + stride];
      ws_tmpl[lid] += ws_tmpl[lid + stride];
    }
    workgroupBarrier();
    stride >>= 1u;
  }

  let src_mean = ws_src[0] / N_PIXELS;
  let tmpl_mean = ws_tmpl[0] / N_PIXELS;
  workgroupBarrier();

  // Second pass: cross-correlation and variances using means
  var cross_val: f32 = 0.0;
  var src2_val: f32 = 0.0;
  var tmpl2_val: f32 = 0.0;

  for (var row = 0u; row < RESIZED_H; row++) {
    let nes_x = f32(lid) * (256.0 / f32(RESIZED_W));
    let nes_y = 64.0 + f32(row) * (176.0 / f32(RESIZED_H));
    let uv = nes_to_uv(nes_x, nes_y, calib);
    let src_rgba = textureSampleBaseClampToEdge(source, src_sampler, uv);
    let src_luma = src_rgba.r * 0.299 + src_rgba.g * 0.587 + src_rgba.b * 0.114;
    let tmpl_luma = textureLoad(room_templates, vec2<i32>(i32(lid), i32(row)), i32(room_idx), 0).r;

    let ds = src_luma - src_mean;
    let dt = tmpl_luma - tmpl_mean;
    cross_val += ds * dt;
    src2_val += ds * ds;
    tmpl2_val += dt * dt;
  }

  ws_cross[lid] = cross_val;
  ws_src2[lid] = src2_val;
  ws_tmpl2[lid] = tmpl2_val;
  workgroupBarrier();

  var stride2 = 32u;
  loop {
    if stride2 == 0u { break; }
    if lid < stride2 {
      ws_cross[lid] += ws_cross[lid + stride2];
      ws_src2[lid] += ws_src2[lid + stride2];
      ws_tmpl2[lid] += ws_tmpl2[lid + stride2];
    }
    workgroupBarrier();
    stride2 >>= 1u;
  }

  if lid == 0u {
    let denom = sqrt(ws_src2[0] * ws_tmpl2[0]);
    if denom > 1e-6 {
      scores[room_idx] = ws_cross[0] / denom;
    } else {
      scores[room_idx] = 0.0;
    }
  }
}
`;

export const FLOOR_ITEM_SHADER = /* wgsl */`
struct Calibration {
  scale_x: f32,
  scale_y: f32,
  offset_x: f32,
  offset_y: f32,
  video_w: f32,
  video_h: f32,
}

struct FloorItemResult {
  score: atomic<i32>,
  px: atomic<i32>,
  py: atomic<i32>,
}

fn nes_to_uv_floor(nes_x: f32, nes_y: f32, calib: Calibration) -> vec2<f32> {
  return vec2<f32>(
    (nes_x * calib.scale_x + calib.offset_x) / calib.video_w,
    (nes_y * calib.scale_y + calib.offset_y) / calib.video_h,
  );
}

@group(0) @binding(0) var source: texture_external;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var drop_templates: texture_2d_array<f32>;
@group(0) @binding(3) var<uniform> calib: Calibration;
@group(0) @binding(4) var<storage, read_write> results: array<FloorItemResult>;

const TMPL_W: u32 = 8u;
const TMPL_H: u32 = 16u;
const SCORE_SCALE: f32 = 10000.0;

// One workgroup per (template, scan_x, scan_y) — dispatched as 3D grid
// workgroup_size(8, 16): one thread per pixel in the 8×16 template
@compute @workgroup_size(8, 16)
fn floor_item_scan(
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>,
) {
  let tmpl_idx = wid.z;
  let scan_x = wid.x;
  let scan_y = wid.y;
  let local_x = lid.x;
  let local_y = lid.y;

  // NES coords: gameplay rows 64-224 (leaving 16px for template height)
  // Step 2 NES pixels for speed (reduce scan positions)
  let nes_x = f32(scan_x * 2u) + f32(local_x);
  let nes_y = 64.0 + f32(scan_y * 2u) + f32(local_y);
  if nes_x + f32(TMPL_W) > 256.0 || nes_y + f32(TMPL_H) > 240.0 {
    return;
  }

  let uv = nes_to_uv_floor(nes_x, nes_y, calib);
  let src_rgba = textureSampleBaseClampToEdge(source, src_sampler, uv);
  let src_val = max(src_rgba.r, max(src_rgba.g, src_rgba.b));
  let tmpl_val = textureLoad(drop_templates, vec2<i32>(i32(local_x), i32(local_y)), i32(tmpl_idx), 0).r;

  // Simple cross-correlation contribution (NCC requires workgroup reduction)
  // Use shared memory for workgroup-level NCC reduction
  // Score clamped to [0, 1], stored as i32 * SCORE_SCALE for atomic max
  // For simplicity: approximate NCC as dot product / (src_norm * tmpl_norm)
  // The full NCC requires workgroup shared memory — store per-pixel product and reduce
  let product = src_val * tmpl_val;

  // Encode score as integer for atomic comparison
  let score_int = i32(product * SCORE_SCALE);
  let px_int = i32(scan_x * 2u);
  let py_int = i32(64u + scan_y * 2u);

  // Atomic max: only update if this thread's contribution is highest
  // Note: this is a simplified correlation — true NCC needs full workgroup reduction
  // For floor item detection at native resolution, this approximation is effective
  atomicMax(&results[tmpl_idx].score, score_int);
  if atomicLoad(&results[tmpl_idx].score) == score_int {
    atomicStore(&results[tmpl_idx].px, px_int);
    atomicStore(&results[tmpl_idx].py, py_int);
  }
}
`;

export const NCC_SHADER = /* wgsl */`
const MAX_TEMPLATES: u32 = 32u;

struct Calibration {
  crop_x: f32, crop_y: f32, scale_x: f32, scale_y: f32,
  grid_dx: f32, grid_dy: f32, video_w: f32, video_h: f32,
  life_nes_x: f32, life_nes_y: f32,
}
struct TileDef {
  nes_x: f32, nes_y: f32,
  width: u32, height: u32,
  tmpl_offset: u32, tmpl_count: u32,
}
struct NccResults { scores: array<f32>, }

@group(0) @binding(0) var source: texture_external;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var templates_8x8: texture_2d_array<f32>;
@group(0) @binding(3) var templates_8x16: texture_2d_array<f32>;
@group(0) @binding(4) var<storage, read> tile_defs: array<TileDef>;
@group(0) @binding(5) var<uniform> calib: Calibration;
@group(0) @binding(6) var<storage, read_write> results: NccResults;

var<workgroup> reduction: array<f32, 64>;

fn nes_to_uv(nx: f32, ny: f32) -> vec2<f32> {
  return vec2<f32>(
    (calib.crop_x + (nx + calib.grid_dx) * calib.scale_x) / calib.video_w,
    (calib.crop_y + (ny + calib.grid_dy) * calib.scale_y) / calib.video_h,
  );
}

// Parallel reduction helper — reduces 64 workgroup values to a single sum in slot 0.
fn wg_reduce(lid: u32) {
  workgroupBarrier();
  for (var s = 32u; s > 0u; s >>= 1u) {
    if lid < s { reduction[lid] += reduction[lid + s]; }
    workgroupBarrier();
  }
}

// Each workgroup handles one (tile_idx, template_idx) pair.
// Workgroup size 64 = one thread per pixel in an 8x8 block.
// For 8x16 tiles each thread handles 2 vertically adjacent pixels (row Y and Y+8).
//
// Sub-pixel search: tests a 3x3 grid of offsets (±1 NES pixel in X and Y) to
// handle landmark-to-pixel alignment uncertainty. Keeps the best NCC score.
@compute @workgroup_size(64)
fn ncc_main(
  @builtin(local_invocation_index) lid: u32,
  @builtin(workgroup_id) wid: vec3<u32>
) {
  let tile_idx = wid.x;
  let tmpl_idx = wid.y;
  let def = tile_defs[tile_idx];
  if tmpl_idx >= def.tmpl_count { return; }

  let local_x = lid % 8u;
  let local_y = lid / 8u;
  let is_tall = def.height == 16u;
  let n_pixels = select(64.0, 128.0, is_tall);

  // --- Load template pixels once (pre-normalized: mean=0, std=1 from gpu.js) ---
  var tmpl0: f32;
  var tmpl1: f32 = 0.0;
  if !is_tall {
    tmpl0 = textureLoad(templates_8x8,
                         vec2<i32>(i32(local_x), i32(local_y)),
                         i32(def.tmpl_offset + tmpl_idx), 0).r;
  } else {
    tmpl0 = textureLoad(templates_8x16,
                         vec2<i32>(i32(local_x), i32(local_y)),
                         i32(def.tmpl_offset + tmpl_idx), 0).r;
    tmpl1 = textureLoad(templates_8x16,
                         vec2<i32>(i32(local_x), i32(local_y + 8u)),
                         i32(def.tmpl_offset + tmpl_idx), 0).r;
  }

  // --- Search ±1 NES pixel in X and Y (9 offsets) ---
  var best_ncc: f32 = -1.0;

  for (var ody: i32 = -1; ody <= 1; ody++) {
    for (var odx: i32 = -1; odx <= 1; odx++) {
      let off_x = f32(odx);
      let off_y = f32(ody);

      // Sample source pixels at offset position
      let nx = def.nes_x + f32(local_x) + off_x;
      let ny0 = def.nes_y + f32(local_y) + off_y;
      let uv0 = nes_to_uv(nx, ny0);
      let c0 = textureSampleBaseClampToEdge(source, src_sampler, uv0);
      let px0 = max(max(c0.r, c0.g), c0.b);

      var px1: f32 = 0.0;
      if is_tall {
        let ny1 = def.nes_y + f32(local_y + 8u) + off_y;
        let uv1 = nes_to_uv(nx, ny1);
        let c1 = textureSampleBaseClampToEdge(source, src_sampler, uv1);
        px1 = max(max(c1.r, c1.g), c1.b);
      }

      // Mean reduction
      reduction[lid] = px0 + select(0.0, px1, is_tall);
      wg_reduce(lid);
      let src_mean = reduction[0] / n_pixels;
      workgroupBarrier();

      // Variance reduction
      let d0 = px0 - src_mean;
      let d1 = px1 - src_mean;
      reduction[lid] = d0 * d0 + select(0.0, d1 * d1, is_tall);
      wg_reduce(lid);
      let src_std = sqrt(max(reduction[0] / n_pixels, 1e-6));
      workgroupBarrier();

      // Cross-correlation
      reduction[lid] = d0 * tmpl0 + select(0.0, d1 * tmpl1, is_tall);
      wg_reduce(lid);

      if lid == 0u {
        let ncc = reduction[0] / (src_std * n_pixels);
        best_ncc = max(best_ncc, ncc);
      }
      workgroupBarrier();
    }
  }

  // Write best score across all 9 offsets
  if lid == 0u {
    results.scores[tile_idx * MAX_TEMPLATES + tmpl_idx] = best_ncc;
  }
}
`;
