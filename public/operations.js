/**
 * CutFlow AI — operation registry.
 *
 * One place that defines every edit the app can perform, what parameters it
 * accepts, and the exact FFmpeg arguments it produces. The AI picks an
 * operation name; this file decides what actually runs, so a bad or
 * hallucinated response can never produce an invalid command line.
 *
 * Every filter used here was verified to exist in the shipped WASM build.
 */

/* ── coercion helpers ─────────────────────────────────────────────────────── */

export function num(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** H.264 requires even dimensions. */
export function even(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v + 1;
}

/**
 * atempo accepts 0.5–2.0 per instance and only a literal float — never an
 * expression like "1/2". Anything outside the range must be chained.
 */
export function atempoChain(speed) {
  let s = clamp(speed, 0.125, 16);
  const parts = [];
  while (s > 2.0) { parts.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s *= 2; }
  parts.push(`atempo=${s.toFixed(6)}`);
  return parts.join(',');
}

/** Escape text for drawtext (colons and backslashes are separators). */
function esc(t) {
  return String(t)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 120);
}

/* ── named looks ──────────────────────────────────────────────────────────── */

// Editing above 720p costs a lot of wasm CPU for detail nobody sees in a
// social clip. Exports are capped here.
const MAX_EDIT_WIDTH = 1280;

const GRADES = {
  // colorbalance is disproportionately expensive in the wasm build (~8s on a
  // 6s 1080p clip vs ~3.6s for colorchannelmixer and ~0.2s for eq), so the
  // tints below are expressed with the cheaper filters. Measured, not guessed.
  warm:      'colorchannelmixer=rr=1.12:bb=0.88',
  cool:      'colorchannelmixer=rr=0.88:bb=1.12',
  vintage:   'curves=preset=vintage',
  cinematic: 'colorchannelmixer=rr=1.06:bb=0.94,eq=contrast=1.15:saturation=1.1',
  teal:      'colorchannelmixer=rr=0.92:bb=1.1,eq=contrast=1.1',
  noir:      'hue=s=0,eq=contrast=1.4:brightness=-0.05',
  dramatic:  'eq=contrast=1.35:saturation=1.2:brightness=-0.03,vignette=PI/5',
  bright:    'eq=brightness=0.12:contrast=1.05',
  faded:     'curves=preset=lighter,eq=saturation=0.75',
};

const EFFECTS = {
  blur:       () => 'boxblur=5:1',
  gblur:      (p) => `gblur=sigma=${clamp(num(p.intensity, 50) / 10, 0.5, 20).toFixed(2)}`,
  sharpen:    () => 'unsharp=5:5:1.5',
  grayscale:  () => 'hue=s=0',
  sepia:      () => 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  vintage:    () => 'curves=preset=vintage',
  emboss:     () => 'convolution=-2 -1 0:-1 1 1:0 1 2',
  edge:       () => 'edgedetect=low=0.1:high=0.4',
  negate:     () => 'negate',
  vignette:   () => 'vignette=PI/4',
  pixelate:   (p) => `pixelize=w=${clamp(Math.round(num(p.intensity, 16)), 2, 64)}:h=${clamp(Math.round(num(p.intensity, 16)), 2, 64)}`,
  noise:      () => 'noise=alls=20:allf=t',
  denoise:    () => 'hqdn3d=4:3:6:4.5',
  brightness: (p) => `eq=brightness=${clamp(num(p.intensity, 50) / 100 - 0.5, -1, 1).toFixed(3)}`,
  contrast:   (p) => `eq=contrast=${clamp(num(p.intensity, 50) / 50, 0, 3).toFixed(3)}`,
  saturation: (p) => `eq=saturation=${clamp(num(p.intensity, 50) / 50, 0, 3).toFixed(3)}`,
  warm:       () => GRADES.warm,
  cool:       () => GRADES.cool,
};

/* ── aspect presets ───────────────────────────────────────────────────────── */

const ASPECTS = {
  '9:16':  9 / 16,
  '1:1':   1,
  '4:5':   4 / 5,
  '16:9':  16 / 9,
  '4:3':   4 / 3,
};

/* ── the registry ─────────────────────────────────────────────────────────── */
/*
 * Each entry returns { filters, audioFilters, pre, post, lossless, reencodeVideo }
 *   pre  : args placed BEFORE -i (e.g. fast seek)
 *   post : extra output args
 *   lossless      : stream-copy everything (no re-encode at all)
 *   reencodeVideo : false when only audio changed
 */
export const OPERATIONS = {
  trim_video: {
    label: 'Trim',
    build(p, ctx) {
      const dur = ctx.duration || 0;
      let start = clamp(num(p.start, 0), 0, Math.max(0, dur - 0.1));
      let length = num(p.duration, num(p.end, dur) - start);
      if (!Number.isFinite(length) || length <= 0) length = Math.max(0.1, dur - start);
      if (dur) length = Math.min(length, dur - start);
      return {
        // -ss before -i is the fast seek; keyframe-accurate enough for copy
        pre: ['-ss', start.toFixed(3)],
        post: ['-t', length.toFixed(3)],
        lossless: true,
      };
    },
  },

  resize_video: {
    label: 'Resize',
    build(p) {
      const w = even(clamp(num(p.width, 1280), 16, 3840));
      const h = even(clamp(num(p.height, 720), 16, 2160));
      return { filters: [`scale=${w}:${h}`], ownGeometry: true };
    },
  },

  crop_video: {
    label: 'Crop',
    build(p, ctx) {
      const vw = ctx.width || 1280;
      const vh = ctx.height || 720;
      // Aspect-ratio crop is far more useful than raw pixels for social formats
      const ar = p.aspect && ASPECTS[String(p.aspect)];
      if (ar) {
        let w = vw, h = Math.round(vw / ar);
        if (h > vh) { h = vh; w = Math.round(vh * ar); }
        return { filters: [`crop=${even(w)}:${even(h)}:${Math.floor((vw - w) / 2)}:${Math.floor((vh - h) / 2)}`], ownGeometry: true };
      }
      const w = even(clamp(num(p.width, vw), 16, vw));
      const h = even(clamp(num(p.height, vh), 16, vh));
      const x = Math.floor(clamp(num(p.x, (vw - w) / 2), 0, Math.max(0, vw - w)));
      const y = Math.floor(clamp(num(p.y, (vh - h) / 2), 0, Math.max(0, vh - h)));
      return { filters: [`crop=${w}:${h}:${x}:${y}`], ownGeometry: true };
    },
  },

  adjust_speed: {
    label: 'Speed',
    build(p, ctx) {
      const speed = clamp(num(p.speed, num(p.factor, 1)), 0.125, 16);
      return {
        filters: [`setpts=${(1 / speed).toFixed(6)}*PTS`],
        audioFilters: ctx.hasAudio ? [atempoChain(speed)] : null,
      };
    },
  },

  speed_up: {
    label: 'Speed up',
    build(p, ctx) {
      const f = clamp(num(p.factor, num(p.speed, 2)), 1, 16);
      return {
        filters: [`setpts=${(1 / f).toFixed(6)}*PTS`],
        audioFilters: ctx.hasAudio ? [atempoChain(f)] : null,
      };
    },
  },

  slow_motion: {
    label: 'Slow motion',
    build(p, ctx) {
      const f = clamp(num(p.factor, 2), 1, 8);   // factor 2 = half speed
      return {
        filters: [`setpts=${f.toFixed(6)}*PTS`],
        audioFilters: ctx.hasAudio ? [atempoChain(1 / f)] : null,
      };
    },
  },

  mute_audio: {
    label: 'Mute',
    build() {
      return { mute: true, reencodeVideo: false };
    },
  },

  adjust_volume: {
    label: 'Volume',
    build(p, ctx) {
      if (!ctx.hasAudio) return { noop: 'This clip has no audio track.' };
      const lvl = clamp(num(p.level, num(p.volume, 1.5)), 0, 8);
      return { audioFilters: [`volume=${lvl.toFixed(3)}`], reencodeVideo: false };
    },
  },

  color_grade: {
    label: 'Colour grade',
    build(p) {
      const key = String(p.grade || p.style || 'warm').toLowerCase();
      return { filters: [GRADES[key] || GRADES.warm] };
    },
  },

  add_effect: {
    label: 'Effect',
    build(p) {
      const key = String(p.effect || p.filter || 'blur').toLowerCase();
      const fn = EFFECTS[key] || EFFECTS.blur;
      return { filters: [fn(p)] };
    },
  },

  rotate: {
    label: 'Rotate',
    build(p) {
      const deg = ((Math.round(num(p.degrees, num(p.angle, 90))) % 360) + 360) % 360;
      if (deg === 90)  return { filters: ['transpose=1'] };
      if (deg === 180) return { filters: ['transpose=1,transpose=1'] };
      if (deg === 270) return { filters: ['transpose=2'] };
      return { noop: 'Rotation must be 90, 180 or 270 degrees.' };
    },
  },

  flip: {
    label: 'Flip',
    build(p) {
      const dir = String(p.direction || 'horizontal').toLowerCase();
      return { filters: [dir.startsWith('v') ? 'vflip' : 'hflip'] };
    },
  },

  fade: {
    label: 'Fade',
    build(p, ctx) {
      const d = clamp(num(p.duration, 1), 0.1, 10);
      const dur = ctx.duration || 0;
      const type = String(p.type || 'both').toLowerCase();
      const vf = [], af = [];
      if (type === 'in' || type === 'both') {
        vf.push(`fade=t=in:st=0:d=${d}`);
        if (ctx.hasAudio) af.push(`afade=t=in:st=0:d=${d}`);
      }
      if ((type === 'out' || type === 'both') && dur > d) {
        vf.push(`fade=t=out:st=${(dur - d).toFixed(3)}:d=${d}`);
        if (ctx.hasAudio) af.push(`afade=t=out:st=${(dur - d).toFixed(3)}:d=${d}`);
      }
      if (!vf.length) return { noop: 'Clip is too short for that fade.' };
      return { filters: vf, audioFilters: af.length ? af : null };
    },
  },

  reverse: {
    label: 'Reverse',
    build(p, ctx) {
      // reverse buffers every frame in RAM — refuse on long clips
      if ((ctx.duration || 0) > 30) {
        return { noop: 'Reverse only works on clips under 30 seconds (it holds every frame in memory).' };
      }
      return {
        filters: ['reverse'],
        audioFilters: ctx.hasAudio ? ['areverse'] : null,
      };
    },
  },

  add_text: {
    label: 'Add text',
    needsFont: true,
    build(p, ctx) {
      const text = esc(p.text || p.caption || 'CutFlow');
      const size = Math.round(clamp(num(p.size, (ctx.height || 720) / 12), 8, 200));
      const pos = String(p.position || 'bottom').toLowerCase();
      const y = pos.startsWith('top') ? 'h*0.08'
        : pos.startsWith('mid') || pos.startsWith('cent') ? '(h-text_h)/2'
        : 'h*0.85';
      const colour = /^[a-z]+$|^#[0-9a-f]{3,8}$/i.test(String(p.color || '')) ? p.color : 'white';
      return {
        filters: [
          `drawtext=fontfile=/font.ttf:text='${text}':fontcolor=${colour}:fontsize=${size}:` +
          `x=(w-text_w)/2:y=${y}:box=1:boxcolor=black@0.45:boxborderw=${Math.round(size / 5)}`,
        ],
      };
    },
  },

  change_fps: {
    label: 'Frame rate',
    build(p) {
      const fps = clamp(num(p.fps, num(p.rate, 30)), 1, 120);
      return { filters: [`fps=${fps}`] };
    },
  },

  extract_audio: {
    label: 'Extract audio',
    build(p, ctx) {
      if (!ctx.hasAudio) return { noop: 'This clip has no audio to extract.' };
      return { extractAudio: true };
    },
  },

  to_gif: {
    label: 'Make GIF',
    build(p, ctx) {
      if ((ctx.duration || 0) > 15) {
        return { noop: 'GIF export is limited to 15 seconds — trim it first.' };
      }
      // 480px @ 12fps produced a 6.1 MB GIF from a 6s clip — too big to send
      // anywhere. 360px @ 10fps keeps it shareable while still looking fine.
      const fps = clamp(num(p.fps, 10), 4, 20);
      const w = even(clamp(num(p.width, 360), 64, 640));
      return { toGif: true, gifFps: fps, gifWidth: w };
    },
  },

  thumbnail: {
    label: 'Thumbnail',
    build(p, ctx) {
      const at = clamp(num(p.time, num(p.at, 0)), 0, Math.max(0, (ctx.duration || 1) - 0.05));
      return { thumbnail: true, at };
    },
  },

  /* ── added: framing ─────────────────────────────────────────────────────── */

  pad_video: {
    label: 'Fit with bars',
    build(p, ctx) {
      const ar = ASPECTS[String(p.aspect)] || 9 / 16;
      // Cap the LONG edge, not the width: sizing a 9:16 canvas off a landscape
      // width produced 1280x2276 (11 MB). Capping the long edge gives the
      // conventional 720x1280 instead.
      let tw, th;
      if (ar < 1) { th = MAX_EDIT_WIDTH; tw = Math.round(MAX_EDIT_WIDTH * ar); }
      else { tw = MAX_EDIT_WIDTH; th = Math.round(MAX_EDIT_WIDTH / ar); }
      const colour = /^[a-z]+$|^#[0-9a-f]{3,6}$/i.test(String(p.color || '')) ? p.color : 'black';
      return {
        ownGeometry: true,
        filters: [
          `scale=${even(tw)}:${even(th)}:force_original_aspect_ratio=decrease`,
          `pad=${even(tw)}:${even(th)}:(ow-iw)/2:(oh-ih)/2:${colour}`,
          'setsar=1',
        ],
      };
    },
  },

  blur_background: {
    label: 'Blurred background',
    build(p, ctx) {
      // The look every phone editor has: blurred fill behind the whole frame.
      const ar = ASPECTS[String(p.aspect)] || 9 / 16;
      const th = even(clamp(ctx.height || 720, 240, 1280));
      const tw = even(Math.round(th * ar));
      return {
        ownGeometry: true,
        complex:
          `[0:v]split=2[bg][fg];` +
          `[bg]scale=${tw}:${th}:force_original_aspect_ratio=increase,` +
          `crop=${tw}:${th},gblur=sigma=20[bgb];` +
          `[fg]scale=${tw}:${th}:force_original_aspect_ratio=decrease[fgs];` +
          `[bgb][fgs]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`,
        mapVideo: '[v]',
      };
    },
  },

  scale_by: {
    label: 'Scale',
    build(p, ctx) {
      const f = clamp(num(p.factor, 0.5), 0.1, 4);
      const w = even(clamp((ctx.width || 1280) * f, 16, 3840));
      return { ownGeometry: true, filters: [`scale=${w}:-2`] };
    },
  },

  zoom: {
    label: 'Zoom',
    build(p, ctx) {
      const f = clamp(num(p.factor, 1.2), 1.01, 4);
      // Crop first, then scale to the capped width. Cropping the *source* and
      // upscaling once is far cheaper than scaling the whole frame up first.
      const w = even(Math.min(MAX_EDIT_WIDTH, ctx.width || MAX_EDIT_WIDTH));
      return {
        ownGeometry: true,
        filters: [`crop=iw/${f.toFixed(3)}:ih/${f.toFixed(3)}`, `scale=${w}:-2`],
      };
    },
  },

  add_border: {
    label: 'Border',
    build(p, ctx) {
      const s = Math.round(clamp(num(p.size, 20), 1, 200));
      const colour = /^[a-z]+$|^#[0-9a-f]{3,6}$/i.test(String(p.color || '')) ? p.color : 'white';
      const pre = (ctx.width || 0) > MAX_EDIT_WIDTH ? [`scale='min(${MAX_EDIT_WIDTH},iw)':-2`] : [];
      return { ownGeometry: true, filters: [...pre, `pad=iw+${s * 2}:ih+${s * 2}:${s}:${s}:${colour}`] };
    },
  },

  /* ── added: motion ──────────────────────────────────────────────────────── */

  timelapse: {
    label: 'Timelapse',
    build(p) {
      const f = clamp(num(p.factor, 8), 2, 60);
      // Drop audio: at 8x+ it is unusable anyway, and skipping atempo is faster.
      return { filters: [`setpts=PTS/${f.toFixed(4)}`], mute: true };
    },
  },

  boomerang: {
    label: 'Boomerang',
    build(p, ctx) {
      if ((ctx.duration || 0) > 15) {
        return { noop: 'Boomerang works on clips up to 15 seconds — trim it first.' };
      }
      return {
        complex:
          `[0:v]scale='min(${MAX_EDIT_WIDTH},iw)':-2,split=2[a][b];` +
          `[b]reverse[r];[a][r]concat=n=2:v=1:a=0[v]`,
        mapVideo: '[v]',
        mute: true,
      };
    },
  },

  loop_video: {
    label: 'Loop',
    build(p, ctx) {
      const n = Math.round(clamp(num(p.count, 2), 2, 10));
      if ((ctx.duration || 0) * n > 120) {
        return { noop: 'That would make a very long video — try a shorter clip.' };
      }
      const ins = Array.from({ length: n }, (_, i) => `[s${i}]`).join('');
      return {
        complex:
          `[0:v]scale='min(${MAX_EDIT_WIDTH},iw)':-2,split=${n}` +
          Array.from({ length: n }, (_, i) => `[s${i}]`).join('') + ';' +
          `${ins}concat=n=${n}:v=1:a=0[v]`,
        mapVideo: '[v]', mute: true,
      };
    },
  },

  stabilize: {
    label: 'Stabilise',
    build() {
      // vidstab isn't in the wasm build; deshake is and needs no second pass.
      // rx/ry=32 timed out (>90s on a 6s clip) — the search window is O(rx*ry)
      // per block. 16 is the largest radius that stays interactive, and 960px
      // keeps the block count down. Measured, not guessed.
      // deshake REQUIRES rx/ry to be multiples of 16 (rx=12 fails the filter
      // graph and yields a 0-byte file). 16 is therefore the minimum; the
      // speed comes from capping resolution instead, since cost scales with
      // pixel count. 720px keeps a 6s clip near ~20s.
      return {
        ownGeometry: true,
        filters: [`scale='min(720,iw)':-2`, 'deshake=rx=16:ry=16:edge=mirror'],
      };
    },
  },

  hue_rotate: {
    label: 'Hue shift',
    build(p) {
      const d = Math.round(num(p.degrees, 90)) % 360;
      return { filters: [`hue=h=${d}`] };
    },
  },

  /* ── added: audio ───────────────────────────────────────────────────────── */

  normalize_audio: {
    label: 'Normalise audio',
    build(p, ctx) {
      if (ctx.hasAudio === false) return { noop: 'This clip has no audio to normalise.' };
      // Single-pass loudnorm to EBU R128; the two-pass version needs a probe.
      return { audioFilters: ['loudnorm=I=-16:TP=-1.5:LRA=11'], reencodeVideo: false };
    },
  },

  denoise_audio: {
    label: 'Clean audio',
    build(p, ctx) {
      if (ctx.hasAudio === false) return { noop: 'This clip has no audio to clean.' };
      return { audioFilters: ['highpass=f=80', 'afftdn=nf=-25', 'lowpass=f=15000'], reencodeVideo: false };
    },
  },

  fade_audio: {
    label: 'Audio fade',
    build(p, ctx) {
      if (ctx.hasAudio === false) return { noop: 'This clip has no audio to fade.' };
      const d = clamp(num(p.duration, 1), 0.1, Math.max(0.2, (ctx.duration || 4) / 2));
      const type = String(p.type || 'both');
      const out = Math.max(0, (ctx.duration || 0) - d);
      const f = [];
      if (type === 'in' || type === 'both') f.push(`afade=t=in:st=0:d=${d.toFixed(2)}`);
      if ((type === 'out' || type === 'both') && ctx.duration) f.push(`afade=t=out:st=${out.toFixed(2)}:d=${d.toFixed(2)}`);
      return { audioFilters: f.length ? f : ['anull'], reencodeVideo: false };
    },
  },

  /* ── added: delivery ────────────────────────────────────────────────────── */

  compress: {
    label: 'Compress',
    build(p, ctx) {
      const heavy = String(p.level || 'medium') === 'high';
      const w = heavy ? 854 : 1280;
      const src = ctx.width || 0;
      return {
        ownGeometry: true,
        filters: [`scale='min(${w},iw)':-2`],
        // A slower preset genuinely pays for itself here: the point is bytes.
        encode: { preset: 'veryfast', crf: heavy ? 32 : 28 },
        audioBitrate: heavy ? '96k' : '128k',
        forceReencodeAudio: true,
        _src: src,
      };
    },
  },
};

/* ── aliases the AI (or a user) is likely to produce ──────────────────────── */
export const ALIASES = {
  add_filter: 'add_effect',
  apply_effect: 'add_effect',
  effect: 'add_effect',
  filter: 'add_effect',
  color_correct: 'color_grade',
  grade: 'color_grade',
  colour_grade: 'color_grade',
  cut: 'trim_video',
  trim: 'trim_video',
  clip: 'trim_video',
  scale: 'resize_video',
  resize: 'resize_video',
  crop: 'crop_video',
  speed: 'adjust_speed',
  fast_forward: 'speed_up',
  slowmo: 'slow_motion',
  slow_down: 'slow_motion',
  mute: 'mute_audio',
  silence: 'mute_audio',
  volume: 'adjust_volume',
  rotate_video: 'rotate',
  flip_video: 'flip',
  mirror: 'flip',
  text: 'add_text',
  caption: 'add_text',
  subtitle: 'add_text',
  watermark: 'add_text',
  fps: 'change_fps',
  framerate: 'change_fps',
  gif: 'to_gif',
  make_gif: 'to_gif',
  screenshot: 'thumbnail',
  frame: 'thumbnail',
  audio: 'extract_audio',
  // added ops
  letterbox: 'pad_video',
  pad: 'pad_video',
  fit: 'pad_video',
  blur_bg: 'blur_background',
  background_blur: 'blur_background',
  scale_percent: 'scale_by',
  punch_in: 'zoom',
  border: 'add_border',
  time_lapse: 'timelapse',
  hyperlapse: 'timelapse',
  ping_pong: 'boomerang',
  loop: 'loop_video',
  repeat: 'loop_video',
  deshake: 'stabilize',
  stabilise: 'stabilize',
  steady: 'stabilize',
  hue: 'hue_rotate',
  tint: 'hue_rotate',
  normalize_volume: 'normalize_audio',
  normalise_audio: 'normalize_audio',
  loudnorm: 'normalize_audio',
  clean_audio: 'denoise_audio',
  audio_denoise: 'denoise_audio',
  noise_reduction: 'denoise_audio',
  audio_fade: 'fade_audio',
  compress_video: 'compress',
  reduce_size: 'compress',
  optimize: 'compress',
  optimise: 'compress',
};

export function resolveOperation(name) {
  const key = String(name || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (OPERATIONS[key]) return key;
  if (ALIASES[key]) return ALIASES[key];
  return null;
}

/**
 * Turn a validated operation into a complete FFmpeg argv.
 * ctx: { duration, width, height, hasAudio, threads, isMT }
 */
export function buildArgs(opName, params, ctx) {
  const key = resolveOperation(opName);
  if (!key) return { error: `I don't know how to "${opName}" yet.` };

  const spec = OPERATIONS[key];
  const plan = spec.build(params || {}, ctx) || {};
  if (spec.needsFont) plan.needsFont = true;
  if (plan.noop) return { error: plan.noop };

  const inputName = ctx.inputName || 'input.mp4';
  const args = [];
  let outputName = 'output.mp4';

  if (plan.pre) args.push(...plan.pre);
  args.push('-i', inputName);

  /* ---- special outputs ---- */
  if (plan.thumbnail) {
    return {
      args: ['-ss', String(plan.at), '-i', inputName, '-frames:v', '1', '-q:v', '2', 'thumb.jpg'],
      outputName: 'thumb.jpg', mime: 'image/jpeg', ext: 'jpg', kind: 'image', label: spec.label,
    };
  }
  if (plan.extractAudio) {
    return {
      args: ['-i', inputName, '-vn', '-c:a', 'libmp3lame', '-q:a', '2', 'audio.mp3'],
      outputName: 'audio.mp3', mime: 'audio/mpeg', ext: 'mp3', kind: 'audio', label: spec.label,
    };
  }
  if (plan.toGif) {
    return {
      args: [
        '-i', inputName,
        '-vf', `fps=${plan.gifFps},scale=${plan.gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
        '-loop', '0', 'out.gif',
      ],
      outputName: 'out.gif', mime: 'image/gif', ext: 'gif', kind: 'image', label: spec.label,
    };
  }

  /* ---- normal video output ---- */
  // Downscale BEFORE the effect chain, never after: filtering at full 1080p
  // and then shrinking measured 34.8s, while shrinking first measured 21.7s
  // for an identical-looking result. Ops that set their own geometry
  // (resize/crop) opt out via plan.ownGeometry.
  const filters = (plan.filters || []).slice();
  if (!plan.ownGeometry && !plan.complex && !plan.lossless && plan.reencodeVideo !== false) {
    const src = ctx.width || 0;
    if (!src || src > MAX_EDIT_WIDTH) {
      filters.unshift(`scale='min(${MAX_EDIT_WIDTH},iw)':-2`);
    }
  }
  // filter_complex (split/overlay/concat) is mutually exclusive with -vf.
  if (plan.complex) {
    args.push('-filter_complex', plan.complex);
    if (plan.mapVideo) args.push('-map', plan.mapVideo);
    if (!plan.mute && ctx.hasAudio && plan.mapAudio) args.push('-map', plan.mapAudio);
  } else if (filters.length) {
    args.push('-vf', filters.join(','));
  }
  if (plan.audioFilters && plan.audioFilters.length) args.push('-af', plan.audioFilters.join(','));
  if (plan.mute) args.push('-an');
  if (plan.post) args.push(...plan.post);

  const videoUntouched = plan.reencodeVideo === false || plan.lossless;

  if (plan.lossless) {
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  } else if (videoUntouched) {
    args.push('-c:v', 'copy');
    if (!plan.mute && ctx.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
  } else {
    // Ops that exist to shrink the file (compress) may ask for a slower
    // preset: spending CPU is the entire point there.
    const enc = plan.encode || {};
    args.push('-c:v', 'libx264', '-preset', String(enc.preset || 'ultrafast'),
      '-crf', String(enc.crf != null ? enc.crf : 28));
    args.push('-pix_fmt', 'yuv420p');
    // single-threaded core: -threads is a no-op and can confuse the muxer
    if (plan.mute) {
      /* -an already added */
    } else if (ctx.hasAudio) {
      const reAudio = plan.audioFilters || plan.forceReencodeAudio;
      args.push('-c:a', reAudio ? 'aac' : 'copy');
      if (reAudio) args.push('-b:a', String(plan.audioBitrate || '160k'));
    }
  }

  args.push('-movflags', '+faststart');
  args.push(outputName);

  return { args, outputName, mime: 'video/mp4', ext: 'mp4', kind: 'video', label: spec.label, needsFont: !!plan.needsFont };
}
