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
        // Express the crop RELATIVE to the real input (iw/ih) rather than the
        // probed size. If probing failed or is stale, absolute pixels can
        // exceed the frame and ffmpeg writes a 0-byte file; min() can't.
        const arStr = ar.toFixed(6);
        return {
          ownGeometry: true,
          filters: [
            `crop='min(iw,ih*${arStr})':'min(ih,iw/${arStr})':` +
              `'(iw-min(iw,ih*${arStr}))/2':'(ih-min(ih,iw/${arStr}))/2'`,
            // Guarantee even dimensions for H.264 after a dynamic crop.
            `scale=trunc(iw/2)*2:trunc(ih/2)*2`,
          ],
        };
      }
      const w = even(clamp(num(p.width, vw), 16, vw));
      const h = even(clamp(num(p.height, vh), 16, vh));
      const x = Math.floor(clamp(num(p.x, (vw - w) / 2), 0, Math.max(0, vw - w)));
      const y = Math.floor(clamp(num(p.y, (vh - h) / 2), 0, Math.max(0, vh - h)));
      // Clamp against the real frame so a stale probe can't overflow it.
      return {
        ownGeometry: true,
        filters: [`crop='min(${w},iw)':'min(${h},ih)':'min(${x},iw-ow)':'min(${y},ih-oh)'`],
      };
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

  /* ── aura / edit-culture looks ──────────────────────────────────────────── */

  add_sfx: {
    label: 'Add sound effect',
    build(p, ctx) {
      const name = resolveSfx(p.sfx || p.sound || p.name || 'whoosh');
      if (!name) {
        return { noop: `I don't have a "${p.sfx || p.sound}" sound. Try whoosh, riser, sub drop, impact, tick or rev.` };
      }
      const dur = ctx.duration || 0;
      // Default to the very start; "at 3s" places it precisely.
      let at = num(p.at, 0);
      if (dur) at = clamp(at, 0, Math.max(0, dur - 0.05));
      const gain = clamp(num(p.gain, 1), 0.1, 3);
      return {
        sfxCues: [{ sfx: name, at, gain }],
        sfxKeepOriginal: p.replace !== true && p.sfxOnly !== true,
        sfxDuck: clamp(num(p.duck, 0.65), 0, 1),
        reencodeVideo: false,          // audio-only change: copy the video stream
      };
    },
  },

  beat_sfx: {
    label: 'Beat-synced SFX',
    build(p, ctx) {
      const bpm = clamp(num(p.bpm, 120), 40, 240);
      const dur = ctx.duration || 10;
      const name = resolveSfx(p.sfx || p.sound || 'impact') || 'impact';
      const every = Math.max(1, Math.round(num(p.every, 1)));   // hit every Nth beat
      const times = beatTimes(bpm, dur, num(p.offset, 0)).filter((_, i) => i % every === 0);
      if (!times.length) return { noop: 'This clip is too short to place beats on.' };
      // 16 inputs is plenty; each one costs decode time.
      const cues = times.slice(0, 16).map(at => ({ sfx: name, at, gain: 1 }));
      return {
        sfxCues: cues,
        sfxKeepOriginal: p.replace !== true,
        sfxDuck: clamp(num(p.duck, 0.6), 0, 1),
        reencodeVideo: false,
      };
    },
  },

  car_edit: {
    label: 'Car edit',
    build(p, ctx) {
      // The full automotive/hard-edit treatment in one command: teal-orange
      // grade, bloom on highlights, beat-locked punch zoom, and a sound bed of
      // whooshes + sub drops + impacts locked to the same grid. This is the
      // "one prompt, finished reel" path.
      const bpm = clamp(num(p.bpm, 120), 40, 240);
      const dur = ctx.duration || 10;
      const intensity = clamp(num(p.intensity, 70), 10, 100) / 100;
      const vertical = p.vertical !== false;

      const outH = vertical ? 960 : 540;
      const outW = vertical ? even(Math.round(outH * 9 / 16)) : even(Math.round(outH * 16 / 9));
      const fps = 30;
      const hz = (bpm / 60).toFixed(4);
      const amp = (0.03 + intensity * 0.05).toFixed(4);
      const sigma = (10 + intensity * 10).toFixed(1);

      const frame = vertical
        ? `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`
        : `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`;

      // Teal shadows / warm highlights — the automotive grade.
      const grade = 'colorbalance=rs=-0.06:bs=0.10:rm=0.04:bm=-0.03:rh=0.08:bh=-0.06';

      const complex =
        `[0:v]${frame},${grade},split=2[base][gl];` +
        `[gl]curves=all='0/0 0.45/0 1/1',gblur=sigma=${sigma}[g];` +
        `[base][g]blend=all_mode=screen:all_opacity=${(0.5 + intensity * 0.4).toFixed(2)},` +
        `eq=contrast=${(1.12 + intensity * 0.12).toFixed(2)}:saturation=${(1.15 + intensity * 0.25).toFixed(2)},` +
        `unsharp=5:5:0.8:5:5:0.0,` +
        `zoompan=z='1+${amp}*(0.5+0.5*sin(on/${fps}*${hz}*2*PI))':d=1:s=${outW}x${outH}:fps=${fps},` +
        `vignette=PI/5,noise=alls=5:allf=t,setsar=1[v]`;

      // Sound: a whoosh + sub drop on the downbeat of each bar, impacts on the
      // other beats. Cap the total so the encode stays quick.
      const beats = beatTimes(bpm, dur, num(p.offset, 0), 32);
      const cues = [];
      beats.forEach((at, i) => {
        if (i % 4 === 0) {
          cues.push({ sfx: 'whoosh', at, gain: 0.9 });
          cues.push({ sfx: 'subdrop', at, gain: 1 });
        } else if (i % 2 === 0) {
          cues.push({ sfx: 'impact', at, gain: 0.85 });
        }
      });
      if (p.rev !== false) cues.unshift({ sfx: 'rev', at: 0.1, gain: 0.8 });

      return {
        ownGeometry: true,
        complex,
        mapVideo: '[v]',
        sfxCues: cues.slice(0, 14),
        sfxKeepOriginal: p.mute !== true,
        sfxDuck: clamp(num(p.duck, 0.5), 0, 1),
        encode: { crf: 26 },
      };
    },
  },

  aura_edit: {
    label: 'Aura edit',
    build(p, ctx) {
      // The full one-command look: crop to 9:16, bloom the highlights, push
      // colour, add grain and a vignette — everything an "aura edit of a
      // person" needs, in a single pass so it stays fast.
      const preset = AURA_PRESETS[String(p.style || p.color || '').toLowerCase()] || AURA_PRESETS.default;
      const intensity = clamp(num(p.intensity, 70), 10, 100) / 100;
      const sigma = (14 + intensity * 14).toFixed(1);
      const opacity = (0.55 + intensity * 0.45).toFixed(2);
      const vertical = p.vertical !== false;

      // Target frame: 9:16 because that is how these get posted. 960 tall, not
      // 1152: measured 33.0s vs 40.1s on a 6s clip for detail nobody sees on a
      // phone. crf 28 rather than 24 is the same speed for 1.7 MB vs 3.9 MB.
      const outH = vertical ? 960 : 540;
      const outW = vertical ? even(Math.round(outH * 9 / 16)) : even(Math.round(outH * 16 / 9));

      const frame = vertical
        ? `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}`
        : `scale='min(${auraWidth(ctx)},iw)':-2`;
      const baseTint = preset.baseTint ? `,${preset.baseTint}` : '';
      const glowTint = preset.glowTint ? `,${preset.glowTint}` : '';

      return {
        ownGeometry: true,
        complex:
          `[0:v]${frame}${baseTint},split=2[base][gl];` +
          `[gl]curves=all='0/0 ${preset.crush}/0 1/1',gblur=sigma=${sigma}${glowTint}[g];` +
          `[base][g]blend=all_mode=screen:all_opacity=${opacity},` +
          `eq=contrast=${preset.contrast}:saturation=${preset.saturation}${preset.grade},` +
          `noise=alls=8:allf=t,vignette=PI/4,setsar=1[v]`,
        mapVideo: '[v]',
        encode: { crf: 28 },
      };
    },
  },

  aura: {
    label: 'Aura',
    build(p, ctx) {
      // The "aura edit" look: bright areas bloom into a soft glow, colour is
      // pushed hard, edges fall off. Built from curves (crush shadows to black)
      // → gblur (bloom) → screen blend (add light back only where it's bright),
      // the FFmpeg equivalent of the Deep Glow workflow editors use.
      const preset = AURA_PRESETS[String(p.style || p.color || '').toLowerCase()] || AURA_PRESETS.default;
      const intensity = clamp(num(p.intensity, 65), 10, 100) / 100;
      const w = auraWidth(ctx);
      const sigma = (14 + intensity * 14).toFixed(1);
      const opacity = (0.55 + intensity * 0.45).toFixed(2);

      const baseTint = preset.baseTint ? `,${preset.baseTint}` : '';
      const glowTint = preset.glowTint ? `,${preset.glowTint}` : '';
      return {
        ownGeometry: true,
        complex:
          `[0:v]scale='min(${w},iw)':-2${baseTint},split=2[base][gl];` +
          `[gl]curves=all='0/0 ${preset.crush}/0 1/1',gblur=sigma=${sigma}${glowTint}[g];` +
          `[base][g]blend=all_mode=screen:all_opacity=${opacity},` +
          `eq=contrast=${preset.contrast}:saturation=${preset.saturation}${preset.grade}` +
          `,vignette=PI/4,setsar=1[v]`,
        mapVideo: '[v]',
        encode: { crf: 26 },
      };
    },
  },

  glow: {
    label: 'Glow',
    build(p, ctx) {
      // Pure bloom, no colour push — for people who want the light, not the grade.
      const intensity = clamp(num(p.intensity, 60), 10, 100) / 100;
      const w = auraWidth(ctx);
      return {
        ownGeometry: true,
        complex:
          `[0:v]scale='min(${w},iw)':-2,split=2[base][gl];` +
          `[gl]curves=all='0/0 0.45/0 1/1',gblur=sigma=${(12 + intensity * 16).toFixed(1)}[g];` +
          `[base][g]blend=all_mode=screen:all_opacity=${(0.5 + intensity * 0.5).toFixed(2)},setsar=1[v]`,
        mapVideo: '[v]',
        encode: { crf: 26 },
      };
    },
  },

  chroma_shift: {
    label: 'Chromatic shift',
    build(p, ctx) {
      const amt = Math.round(clamp(num(p.intensity, 3), 1, 12));
      const w = auraWidth(ctx);
      return {
        ownGeometry: true,
        filters: [`scale='min(${w},iw)':-2`, `rgbashift=rh=-${amt}:bh=${amt}`],
      };
    },
  },

  shake: {
    label: 'Shake',
    build(p, ctx) {
      // Camera-shake via a zoompan wobble. Zoom in slightly first so the frame
      // never exposes an edge as it moves.
      const amt = clamp(num(p.intensity, 50), 10, 100) / 100;
      const px = Math.round(4 + amt * 14);
      const w = auraWidth(ctx);
      return {
        ownGeometry: true,
        filters: [
          `scale='min(${w},iw)':-2`,
          `crop=iw-${px * 2}:ih-${px * 2}:` +
            `'${px}+${px}*sin(n*0.7)':'${px}+${px}*cos(n*0.9)'`,
        ],
        encode: { crf: 24 },
      };
    },
  },

  punch_zoom: {
    label: 'Punch zoom',
    build(p, ctx) {
      // Rhythmic zoom pulse — the beat-sync move every edit uses. bpm drives
      // the pulse rate; without audio analysis this is the honest approximation.
      const bpm = clamp(num(p.bpm, 120), 40, 240);
      const strength = clamp(num(p.intensity, 50), 10, 100) / 100;
      const amp = (0.02 + strength * 0.06).toFixed(4);
      const hz = (bpm / 60).toFixed(4);
      const w = auraWidth(ctx);
      const fps = 30;
      // crop CANNOT change size per frame (it produced a 0-byte file), so the
      // pulse has to come from zoompan, which resamples to a fixed output size.
      // zoompan needs concrete dimensions, so resolve them here.
      const outW = even(Math.min(w, ctx.width || w));
      const outH = even(Math.round(outW * ((ctx.height || 720) / (ctx.width || 1280))));
      return {
        ownGeometry: true,
        filters: [
          `scale=${outW}:${outH}`,
          `zoompan=z='1+${amp}*(0.5+0.5*sin(on/${fps}*${hz}*2*PI))':d=1:s=${outW}x${outH}:fps=${fps}`,
        ],
        encode: { crf: 24 },
      };
    },
  },

  speed_ramp: {
    label: 'Speed ramp',
    build(p, ctx) {
      // Slow, then snap to fast — the classic edit transition. Implemented as
      // two trimmed segments concatenated, since setpts alone can't ramp.
      const d = ctx.duration || 0;
      if (d < 1.5) return { noop: 'Speed ramps need a clip of at least 1.5 seconds.' };
      const split = (d * clamp(num(p.at, 0.4), 0.15, 0.85)).toFixed(3);
      const slow = clamp(num(p.slow, 2), 1.2, 4);
      const fast = clamp(num(p.fast, 2), 1.2, 6);
      const w = auraWidth(ctx);
      return {
        ownGeometry: true,
        complex:
          `[0:v]scale='min(${w},iw)':-2,split=2[a][b];` +
          `[a]trim=0:${split},setpts=PTS*${slow.toFixed(3)}[s];` +
          `[b]trim=${split},setpts=(PTS-STARTPTS)/${fast.toFixed(3)}[f];` +
          `[s][f]concat=n=2:v=1:a=0[v]`,
        mapVideo: '[v]',
        mute: true,
        encode: { crf: 24 },
      };
    },
  },

  film_grain: {
    label: 'Film grain',
    build(p, ctx) {
      const amt = Math.round(clamp(num(p.intensity, 20), 4, 60));
      const w = auraWidth(ctx);
      return {
        ownGeometry: true,
        filters: [`scale='min(${w},iw)':-2`, `noise=alls=${amt}:allf=t+u`],
        encode: { crf: 24 },
      };
    },
  },

  vhs: {
    label: 'VHS',
    build(p, ctx) {
      const w = auraWidth(ctx);
      return {
        ownGeometry: true,
        filters: [
          `scale='min(${w},iw)':-2`,
          'rgbashift=rh=-3:bh=3',
          'noise=alls=14:allf=t',
          'eq=contrast=1.1:saturation=1.25:brightness=0.02',
          'vignette=PI/5',
        ],
        encode: { crf: 24 },
      };
    },
  },
};

/* ── aura presets ─────────────────────────────────────────────────────────── */

/**
 * Aura work is expensive (split + blur + blend on every frame), so it runs at
 * 720px rather than the usual 1280px cap. Vertical output is what these edits
 * are for anyway, and it roughly halves the render time.
 */

/* ── synthesized sound effects ────────────────────────────────────────────
 *
 * Every SFX is generated by FFmpeg itself via lavfi, so the app ships no
 * audio assets, needs no network, and has nothing to license.
 *
 * The one piece of real maths here: for a frequency sweep the oscillator
 * argument must be the INTEGRAL of frequency over time, not frequency*time.
 * Writing sin(2*PI*f(t)*t) detunes the sweep badly (it sweeps at twice the
 * intended rate). For an exponential decay f(t)=f0*exp(-k*t) the integral is
 * f0*(1-exp(-k*t))/k; for a linear ramp f0→f1 over d it is f0*t+(f1-f0)*t²/2d.
 * Both are expanded by the helpers below.
 *
 * Levels were measured, not guessed: each sound was rendered and checked for
 * peak/RMS/clipping. All sit at peak ≈0.5-0.99 with 0.00% clipped samples.
 */

/** Phase for an exponentially decaying sweep starting at f0. */
function expSweep(f0, k) {
  return `2*PI*${f0}*(1-exp(-${k}*t))/${k}`;
}

/** Phase for a linear ramp f0 → f1 across d seconds. */
function rampSweep(f0, f1, d) {
  return `2*PI*(${f0}*t+(${f1}-${f0})*t*t/(2*${d}))`;
}

export const SFX_LIBRARY = {
  // Airy transition swell — the standard cut/pan cover.
  whoosh: {
    label: 'whoosh',
    duration: 0.75,
    lead: 0.42,                     // peaks 0.42s in: place it BEFORE the hit
    src: 'anoisesrc=d=0.75:c=pink:a=0.85:r=44100',
    chain: "highpass=f=250,lowpass=f=7000,flanger=delay=6:depth=4:speed=0.6," +
           "afade=t=in:st=0:d=0.42:curve=exp,afade=t=out:st=0.42:d=0.33:curve=log,volume=3.6",
  },
  // Tension build that resolves on the beat.
  riser: {
    label: 'riser',
    duration: 1.2,
    lead: 1.1,
    src: `aevalsrc='0.5*sin(${rampSweep(180, 2200, 1.2)})*(t/1.2)^2':d=1.2:s=44100`,
    chain: 'highpass=f=150,aecho=0.8:0.6:40:0.25,afade=t=out:st=1.1:d=0.1,volume=2.8,alimiter=limit=0.92',
  },
  // Falling sub — the sound that makes a car edit feel expensive.
  subdrop: {
    label: 'sub drop',
    duration: 1.4,
    lead: 0,
    src: `aevalsrc='0.95*sin(${expSweep(120, 2.6)})*exp(-1.7*t)':d=1.4:s=44100`,
    chain: 'asubboost=dry=0.9:wet=0.7:decay=0.6,lowpass=f=220,volume=1.15,alimiter=limit=0.92',
  },
  // Body + transient crack. Lands ON the beat.
  impact: {
    label: 'impact',
    duration: 0.9,
    lead: 0,
    src: `aevalsrc='0.9*sin(${expSweep(85, 7)})*exp(-5.5*t)+0.35*random(0)*exp(-55*t)':d=0.9:s=44100`,
    chain: 'lowpass=f=3500,asubboost=dry=0.9:wet=0.55:decay=0.5,volume=1.5,alimiter=limit=0.92',
  },
  // Short tick for off-beat accents.
  tick: {
    label: 'tick',
    duration: 0.18,
    lead: 0,
    src: `aevalsrc='0.6*random(0)*exp(-90*t)':d=0.18:s=44100`,
    chain: 'highpass=f=3000,lowpass=f=11000,volume=4.2',
  },
  // Harmonic engine swell for car edits.
  rev: {
    label: 'engine rev',
    duration: 1.6,
    lead: 0.15,
    src: `aevalsrc='0.4*sin(${rampSweep(60, 190, 1.6)})+0.25*sin(2*${rampSweep(60, 190, 1.6)})+0.15*sin(3*${rampSweep(60, 190, 1.6)})':d=1.6:s=44100`,
    chain: 'tremolo=f=22:d=0.35,lowpass=f=2600,asubboost=dry=0.9:wet=0.5:decay=0.5,' +
           'afade=t=in:d=0.15,afade=t=out:st=1.4:d=0.2,volume=1.5,alimiter=limit=0.92',
  },
};

export const SFX_ALIASES = {
  swoosh: 'whoosh', swish: 'whoosh', woosh: 'whoosh', transition: 'whoosh', swipe: 'whoosh',
  build: 'riser', buildup: 'riser', rise: 'riser', sweep_up: 'riser',
  bass: 'subdrop', drop: 'subdrop', sub: 'subdrop', bass_drop: 'subdrop', boom: 'subdrop',
  hit: 'impact', punch: 'impact', slam: 'impact', bang: 'impact', thud: 'impact', kick: 'impact',
  click: 'tick', tap: 'tick', snap: 'tick',
  engine: 'rev', vroom: 'rev', revving: 'rev', exhaust: 'rev',
};

export function resolveSfx(name) {
  const k = String(name || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (SFX_LIBRARY[k]) return k;
  if (SFX_ALIASES[k]) return SFX_ALIASES[k];
  return null;
}

/**
 * Build a beat grid across the clip.
 *
 * There is no audio-analysis DSP in the wasm build, so beats come from bpm.
 * That is what CapCut templates effectively do too: the editor supplies the
 * tempo and everything snaps to it.
 */
export function beatTimes(bpm, duration, offset = 0, limit = 24) {
  const period = 60 / clamp(num(bpm, 120), 40, 240);
  const times = [];
  for (let t = offset; t < duration - 0.15 && times.length < limit; t += period) {
    times.push(Math.round(t * 1000) / 1000);
  }
  return times;
}

/**
 * Turn a list of {sfx, at} cues into filter_complex audio.
 *
 * Each cue becomes its own lavfi input delayed to its timestamp, then all of
 * them are amixed with the (optionally ducked) original audio. normalize=0 is
 * essential — with the default normalize=1, amix divides every input by the
 * input count, so adding more SFX would make each one quieter.
 */
export function buildSfxAudio(cues, opts = {}) {
  const { hasAudio = false, keepOriginal = true, duckTo = 0.55, inputOffset = 1 } = opts;
  if (!cues.length) return null;

  const inputs = [];
  const parts = [];
  const labels = [];

  let nInputs = 0;
  cues.forEach((cue, i) => {
    const def = SFX_LIBRARY[cue.sfx];
    if (!def) return;
    // FFmpeg counts INPUTS, not argv entries. Each source appends three
    // elements ('-f','lavfi','-i',src === four), so deriving the stream index
    // from inputs.length numbered them 1,5,9... and FFmpeg rejected the graph
    // with "Invalid file index". Track the input count separately.
    const idx = inputOffset + nInputs;
    nInputs += 1;
    inputs.push('-f', 'lavfi', '-i', def.src);
    // Fire early by `lead` so the sound PEAKS on the beat rather than starting
    // there — a whoosh that begins on the cut lands late to the ear.
    const at = Math.max(0, (cue.at || 0) - (cue.lead != null ? cue.lead : def.lead || 0));
    const ms = Math.round(at * 1000);
    const gain = cue.gain != null ? cue.gain : 1;
    const label = `sx${i}`;
    parts.push(`[${idx}:a]adelay=${ms}:all=1,volume=${gain}[${label}]`);
    labels.push(`[${label}]`);
  });

  if (!labels.length) return null;

  let mixIns = labels.slice();
  if (hasAudio && keepOriginal) {
    parts.unshift(`[0:a]volume=${duckTo}[abase]`);
    mixIns = ['[abase]', ...labels];
  }

  // duration=first when there is a real audio bed (match the clip); otherwise
  // pad so the track covers the whole video instead of cutting out early.
  const dur = (hasAudio && keepOriginal) ? 'first' : 'longest';
  const tail = (hasAudio && keepOriginal) ? '' : ',apad';
  parts.push(
    `${mixIns.join('')}amix=inputs=${mixIns.length}:normalize=0:duration=${dur}${tail},` +
    `alimiter=limit=0.95[aout]`
  );

  return { inputs, graph: parts.join(';'), map: '[aout]' };
}

function auraWidth(ctx) {
  return Math.min(720, ctx && ctx.width ? ctx.width : 720);
}

const AURA_PRESETS = {
  // Verified visually, not guessed. The first attempt used lumakey to isolate
  // highlights, but blend=screen IGNORES alpha, so the whole tinted frame got
  // screened on and the result was a flat purple wash over everything.
  // The fix is `curves` to crush shadows to actual BLACK — screen-blending
  // black is a no-op, so the glow only appears where the frame is bright.
  default: { crush: 0.4, baseTint: '',                                        glowTint: '',                                            contrast: 1.18, saturation: 1.35, grade: '' },
  purple:  { crush: 0.4, baseTint: 'colorchannelmixer=rr=1.05:bb=1.15',       glowTint: 'colorchannelmixer=rr=1.3:bb=1.6:gg=0.85',     contrast: 1.18, saturation: 1.4,  grade: '' },
  blue:    { crush: 0.4, baseTint: 'colorchannelmixer=rr=0.95:bb=1.15',       glowTint: 'colorchannelmixer=rr=0.8:bb=1.7:gg=1.0',      contrast: 1.18, saturation: 1.35, grade: '' },
  red:     { crush: 0.4, baseTint: 'colorchannelmixer=rr=1.12:bb=0.95',       glowTint: 'colorchannelmixer=rr=1.7:bb=0.85:gg=0.85',    contrast: 1.2,  saturation: 1.4,  grade: '' },
  gold:    { crush: 0.4, baseTint: 'colorchannelmixer=rr=1.1:gg=1.04:bb=0.9', glowTint: 'colorchannelmixer=rr=1.6:gg=1.3:bb=0.6',      contrast: 1.18, saturation: 1.4,  grade: '' },
  green:   { crush: 0.4, baseTint: 'colorchannelmixer=gg=1.1:rr=0.96',        glowTint: 'colorchannelmixer=gg=1.6:rr=0.85:bb=0.9',     contrast: 1.18, saturation: 1.35, grade: '' },
  pink:    { crush: 0.4, baseTint: 'colorchannelmixer=rr=1.1:bb=1.08',        glowTint: 'colorchannelmixer=rr=1.65:bb=1.35:gg=0.9',    contrast: 1.18, saturation: 1.4,  grade: '' },
  white:   { crush: 0.45, baseTint: '',                                       glowTint: '',                                            contrast: 1.14, saturation: 1.2,  grade: '' },
  dark:    { crush: 0.55, baseTint: '',                                       glowTint: '',                                            contrast: 1.35, saturation: 1.15, grade: ':brightness=-0.04' },
};

/* ── aliases the AI (or a user) is likely to produce ──────────────────────── */
export const ALIASES = {
  /* sound design + car edit */
  sfx: 'add_sfx',
  sound_effect: 'add_sfx',
  sound: 'add_sfx',
  whoosh: 'add_sfx',
  swoosh: 'add_sfx',
  bass_drop: 'add_sfx',
  sub_drop: 'add_sfx',
  boom: 'add_sfx',
  impact_sound: 'add_sfx',
  riser: 'add_sfx',
  beat_sync: 'beat_sfx',
  sync_to_beat: 'beat_sfx',
  beat_sounds: 'beat_sfx',
  hard_edit: 'car_edit',
  car: 'car_edit',
  cinematic_car: 'car_edit',
  auto_edit: 'car_edit',

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
  // aura family
  aura_effect: 'aura',
  auras: 'aura',
  glow_effect: 'glow',
  bloom: 'glow',
  rgb_split: 'chroma_shift',
  chromatic_aberration: 'chroma_shift',
  glitch: 'chroma_shift',
  camera_shake: 'shake',
  handheld: 'shake',
  beat_zoom: 'punch_zoom',
  zoom_pulse: 'punch_zoom',
  ramp: 'speed_ramp',
  grain: 'film_grain',
  retro: 'vhs',
  full_edit: 'aura_edit',
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

  // Sound design: each cue is an extra lavfi input, so they must be declared
  // immediately after the main input and before any -filter_complex.
  let sfx = null;
  if (plan.sfxCues && plan.sfxCues.length) {
    sfx = buildSfxAudio(plan.sfxCues, {
      hasAudio: !!ctx.hasAudio,
      keepOriginal: plan.sfxKeepOriginal !== false,
      duckTo: plan.sfxDuck != null ? plan.sfxDuck : 0.55,
      inputOffset: 1,
    });
    if (sfx) args.push(...sfx.inputs);
  }

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
  if (sfx) {
    // With SFX the whole job becomes a filter_complex: a plain -vf chain can't
    // coexist with the audio graph, so fold the video filters into it as [v].
    const vChain = plan.complex
      ? plan.complex
      : (filters.length ? `[0:v]${filters.join(',')}[v]` : `[0:v]copy[v]`);
    const vMap = plan.complex ? (plan.mapVideo || '[v]') : '[v]';
    args.push('-filter_complex', `${vChain};${sfx.graph}`);
    args.push('-map', vMap, '-map', sfx.map);
  } else if (plan.complex) {
    args.push('-filter_complex', plan.complex);
    if (plan.mapVideo) args.push('-map', plan.mapVideo);
    if (!plan.mute && ctx.hasAudio && plan.mapAudio) args.push('-map', plan.mapAudio);
  } else if (filters.length) {
    args.push('-vf', filters.join(','));
  }
  if (plan.audioFilters && plan.audioFilters.length) args.push('-af', plan.audioFilters.join(','));
  if (plan.mute && !sfx) args.push('-an');
  if (plan.post) args.push(...plan.post);

  // A filtergraph and stream-copy are mutually exclusive: FFmpeg aborts with
  // "Streamcopy requested for output stream 0:0, which is fed from a complex
  // filtergraph". Audio-only ops normally copy the video to stay fast, but the
  // moment SFX force a filter_complex the video must be re-encoded too.
  const videoUntouched = !sfx && (plan.reencodeVideo === false || plan.lossless);

  if (plan.lossless && !sfx) {
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
    if (sfx) {
      // A synthesized track is always freshly encoded; -shortest stops apad
      // from running the file on forever when there is no original audio bed.
      args.push('-c:a', 'aac', '-b:a', String(plan.audioBitrate || '192k'), '-shortest');
    } else if (plan.mute) {
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
