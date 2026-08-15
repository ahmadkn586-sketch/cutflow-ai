/**
 * CutFlow AI — local command parser.
 *
 * The app used to send EVERY command to Groq, which meant: no API key = no
 * editing, plus a network round-trip (300-1500ms) before any work started, and
 * a hallucinated reply broke the edit entirely.
 *
 * This file understands the overwhelming majority of real editing requests
 * offline, instantly, and for free. The AI is now only a fallback for phrasing
 * this parser genuinely does not recognise.
 *
 * It also supports MULTI-STEP commands ("make it black and white and speed it
 * up 2x"), which the AI path never could — it was hard-limited to one op.
 */

/* ── text normalisation ───────────────────────────────────────────────────── */

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
  half: 0.5, quarter: 0.25, double: 2, triple: 3, twice: 2,
};

/** "two and a half" → 2.5, "1 min 30" → 90 (seconds). */
function normalise(raw) {
  let t = ' ' + String(raw || '').toLowerCase().trim() + ' ';

  t = t
    .replace(/\bb\s*&\s*w\b/g, 'black and white')
    .replace(/\bb\/w\b/g, 'black and white')
    .replace(/&/g, ' and ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ');

  // "1:30" → 90 seconds. Skip known aspect ratios: "9:16" is not a timecode.
  const ASPECT_LITERAL = /^(?:9:16|16:9|1:1|4:5|5:4|4:3|3:4|2:1|21:9)$/;
  t = t.replace(/\b(\d+):(\d{1,2})\b/g, (whole, m, s) =>
    ASPECT_LITERAL.test(whole) ? whole : (s.length === 2 ? String(+m * 60 + +s) : whole));
  // "1 minute 30 seconds" / "1m30s" → seconds
  t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\s*(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/g,
    (_, m, s) => String(+m * 60 + +s));
  t = t.replace(/\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/g, (_, m) => String(+m * 60) + ' seconds');
  // "two and a half" → 2.5
  t = t.replace(/\b(\w+) and a half\b/g, (m, w) =>
    NUMBER_WORDS[w] !== undefined ? String(NUMBER_WORDS[w] + 0.5) : m);
  // "twice/double/triple as fast" carry BOTH a number and the intent word, so
  // emit both — replacing outright loses the verb the rules match on.
  t = t.replace(/\btwice\b/g, '2 times');
  t = t.replace(/\bdouble\b/g, '2 times');
  t = t.replace(/\btriple\b/g, '3 times');
  t = t.replace(/\bhalf speed\b/g, '0.5 speed');
  // spelled-out numerals → digits (only where a count makes sense)
  t = t.replace(/\b([a-z]+)\b/g, (w) =>
    Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w) && !['a', 'an', 'half', 'quarter'].includes(w)
      ? String(NUMBER_WORDS[w]) : w);
  t = t.replace(/\bhalf\b/g, '0.5').replace(/\bquarter\b/g, '0.25');

  return t.replace(/\s+/g, ' ');
}

/** First number in a string, else fallback. */
function firstNum(s, fallback) {
  const m = String(s).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : fallback;
}

/** A percentage like "50%" or "by 20 percent" → 0.5 / 0.2, else null. */
function pct(s) {
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/);
  return m ? parseFloat(m[1]) / 100 : null;
}

/* ── clause splitting ─────────────────────────────────────────────────────── */

// Phrases containing a conjunction that must NOT be split on.
const PROTECTED = [
  'black and white', 'fade in and out', 'in and out', 'salt and pepper',
  'up and down', 'left and right', 'nice and', 'crop and', 'over and over',
];

function splitClauses(text) {
  let t = text;
  const stash = [];
  PROTECTED.forEach((phrase, i) => {
    if (t.includes(phrase)) {
      const key = `\u0000${i}\u0000`;
      t = t.split(phrase).join(key);
      stash.push([key, phrase]);
    }
  });

  const parts = t
    .split(/\s*(?:,\s*(?:and\s+)?then|\s+and\s+then|\s+then\s+|\s*;\s*|\s*,\s*and\s+|\s*\+\s*|\s*,\s*|\s+and\s+also\s+|\s+and\s+)\s*/)
    .map(s => {
      let out = s;
      for (const [key, phrase] of stash) out = out.split(key).join(phrase);
      return out.trim();
    })
    .filter(Boolean);

  return parts.length ? parts : [text];
}

/** Colour + strength for the aura family, pulled out of the raw phrasing. */
function auraParams(t) {
  const colour = (t.match(/\b(purple|violet|blue|cyan|red|crimson|gold(?:en)?|yellow|green|pink|magenta|white|dark|black)\b/) || [])[1];
  const map = {
    violet: 'purple', cyan: 'blue', crimson: 'red', golden: 'gold',
    yellow: 'gold', magenta: 'pink', black: 'dark',
  };
  const style = colour ? (map[colour] || colour) : undefined;
  let intensity;
  const p = pct(t);
  if (p !== null) intensity = p * 100;
  else if (/\b(?:subtle|light|slight|soft|barely|little)\b/.test(t)) intensity = 30;
  else if (/\b(?:heavy|strong|max|intense|crazy|insane|hard|extreme|super)\b/.test(t)) intensity = 95;
  const out = {};
  if (style) out.style = style;
  if (intensity !== undefined) out.intensity = intensity;
  return out;
}

/** Tempo, defaulting to the 120bpm most short-form edits sit near. */
function bpmOf(t, fallback = 120) {
  const m = t.match(/(\d{2,3})\s*bpm/);
  if (m) return +m[1];
  if (/\bfast|hard|hype|aggressive\b/.test(t)) return 140;
  if (/\bslow|chill|calm\b/.test(t)) return 90;
  return fallback;
}

/** "at 3s" / "at 2.5 seconds" / "after 4s" -> seconds. */
function atTime(t) {
  const m = t.match(/\b(?:at|after|on|around)\s+(\d+(?:\.\d+)?)\s*(?:s\b|sec|secs|second|seconds)/);
  return m ? parseFloat(m[1]) : null;
}

/** Which library sound the user asked for. */
function sfxOf(t) {
  if (/\b(?:whoosh|swoosh|woosh|swish|swipe|transition sound)\b/.test(t)) return 'whoosh';
  if (/\b(?:riser|build[\s-]?up|rise|tension)\b/.test(t)) return 'riser';
  if (/\b(?:sub\s*drop|bass\s*drop|bass|sub|808|boom)\b/.test(t)) return 'subdrop';
  if (/\b(?:impact|hit|slam|punch sound|bang|thud|kick)\b/.test(t)) return 'impact';
  if (/\b(?:tick|click|tap|snap)\b/.test(t)) return 'tick';
  if (/\b(?:rev|engine|vroom|exhaust)\b/.test(t)) return 'rev';
  return null;
}

/* ── rules ────────────────────────────────────────────────────────────────── */
/* Ordered: the FIRST match wins, so put specific patterns before generic ones. */

const RULES = [
  /* ---- sound design + car edits (must precede aura: "car edit" contains "edit") ---- */
  {
    // "car edit", "hard edit", "edit like shaheer" -> the full treatment with SFX.
    re: /\bcar\s*edit\b|\bhard\s*edit\b|\b(?:car|automotive|vehicle)\s+(?:montage|reel|video)\b|\bedit\s+(?:my|this|the)\s+(?:car|whip|ride|bmw|mercedes|audi|porsche|benz)\b|\bcinematic\s+car\b/,
    op: (m, t) => {
      const params = { bpm: bpmOf(t), intensity: /\b(?:heavy|hard|crazy|insane|max|extreme)\b/.test(t) ? 95 : 70 };
      if (/\bno\s+(?:rev|engine)\b/.test(t)) params.rev = false;
      if (/\b(?:mute|no)\s+(?:the\s+)?(?:original|original audio|music)\b/.test(t)) params.mute = true;
      if (/\b(?:horizontal|landscape|16[:x\/]9|widescreen)\b/.test(t)) params.vertical = false;
      return { operation: 'car_edit', parameters: params };
    },
  },
  {
    // "add sfx on every beat", "impacts to the beat at 128bpm"
    re: /\b(?:sfx|sound\s*effects?|sounds?|impacts?|hits?|whooshes)\b[^.]*\b(?:every\s+beat|on\s+(?:the\s+)?beat|to\s+the\s+beat|beat\s*sync(?:ed|hronis\w+)?|each\s+beat)\b|\bbeat\s*sync(?:ed|hronis\w+)?\s+(?:sfx|sounds?|effects?)\b/,
    op: (m, t) => {
      const p = { bpm: bpmOf(t), sfx: sfxOf(t) || 'impact' };
      if (/\bevery\s+(?:other|2nd|second)\s+beat\b/.test(t)) p.every = 2;
      if (/\bevery\s+(?:4th|fourth|bar)\b/.test(t)) p.every = 4;
      if (/\breplace\b|\bonly\b|\bmute\b/.test(t)) p.replace = true;
      return { operation: 'beat_sfx', parameters: p };
    },
  },
  {
    // "add a whoosh", "put a bass drop at 3s", "sfx only"
    re: /\b(?:add|put|insert|drop|give\s+me|want|need|include)\b[^.]*\b(?:sfx|sound\s*effects?|whoosh|swoosh|woosh|riser|build[\s-]?up|sub\s*drop|bass\s*drop|808|impact|slam|thud|boom|tick|click|rev|engine sound|vroom)\b|^\s*(?:whoosh|swoosh|riser|bass\s*drop|sub\s*drop|impact|boom|rev)\s*$/,
    op: (m, t) => {
      const p = { sfx: sfxOf(t) || 'whoosh' };
      const at = atTime(t);
      if (at !== null) p.at = at;
      if (/\b(?:sfx|sound)s?\s+only\b|\breplace\s+(?:the\s+)?audio\b|\bmute\s+(?:the\s+)?original\b/.test(t)) p.replace = true;
      if (/\b(?:loud|louder|hard|heavy)\b/.test(t)) p.gain = 1.6;
      if (/\b(?:quiet|quieter|subtle|soft|light)\b/.test(t)) p.gain = 0.6;
      return { operation: 'add_sfx', parameters: p };
    },
  },

  /* ---- aura / edit culture (checked early: these phrases win) ---- */
  {
    // "aura edit", "make me an edit", "edit of him" -> the full look.
    re: /\baura\s*edit\b|\bedit\s*(?:of|for)\s+(?:me|him|her|them|us|this|my)\b|\bmake\s+(?:me\s+)?an?\s+edit\b|\bfull\s+edit\b|\bedit\s+me\b/,
    op: (m, t) => ({ operation: 'aura_edit', parameters: auraParams(t) }),
  },
  {
    re: /\baura\b/,
    op: (m, t) => ({
      // "aura" alone: full edit if they mention a platform/vertical, else just
      // the look applied to the existing framing.
      operation: /\b(?:tiktok|reels?|shorts?|vertical|9[:x\/]16|post)\b/.test(t) ? 'aura_edit' : 'aura',
      parameters: auraParams(t),
    }),
  },
  { re: /\b(?:glow|bloom|shine|radiant|light leak|dreamy)\b/, op: (m, t) => ({ operation: 'glow', parameters: { intensity: pct(t) !== null ? pct(t) * 100 : firstNum(t, 60) } }) },
  { re: /\b(?:chromatic|chroma shift|rgb split|colou?r fringe|glitch)\b/, op: (m, t) => ({ operation: 'chroma_shift', parameters: { intensity: firstNum(t, 3) } }) },
  { re: /\b(?:vhs|retro tape|camcorder|old tape|90s look|80s look)\b/, op: () => ({ operation: 'vhs', parameters: {} }) },
  { re: /\b(?:film grain|grainy|add grain)\b/, op: (m, t) => ({ operation: 'film_grain', parameters: { intensity: firstNum(t, 20) } }) },
  { re: /\b(?:shake|shaky cam|handheld|earthquake|rumble)\b/, op: (m, t) => ({ operation: 'shake', parameters: { intensity: pct(t) !== null ? pct(t) * 100 : firstNum(t, 50) } }) },
  {
    re: /\b(?:punch|beat|bounce|pulse|bpm|zoom to the (?:beat|music)|sync)\b/,
    op: (m, t) => {
      const bpmM = t.match(/(\d{2,3})\s*bpm/);
      return { operation: 'punch_zoom', parameters: { bpm: bpmM ? +bpmM[1] : 120, intensity: 50 } };
    },
  },
  { re: /\b(?:speed ramp|ramp|slow then fast|time ramp)\b/, op: () => ({ operation: 'speed_ramp', parameters: {} }) },

  /* ---- aspect / platform ---- */
  {
    re: /\b(?:tiktok|tik tok|reels?|shorts?|vertical|portrait|9[:x\/]16)\b/,
    op: (m, t) => ({
      operation: /\b(?:blur|fill|background|bg|no crop|without crop)\b/.test(t)
        ? 'blur_background' : 'crop_video',
      parameters: { aspect: '9:16' },
    }),
  },
  { re: /\b(?:instagram|insta|ig)?\s*squares?\b|\b1[:x\/]1\b/, op: () => ({ operation: 'crop_video', parameters: { aspect: '1:1' } }) },
  { re: /\b4[:x\/]5\b|\bportrait post\b/, op: () => ({ operation: 'crop_video', parameters: { aspect: '4:5' } }) },
  { re: /\b(?:youtube|widescreen|landscape|horizontal|16[:x\/]9)\b/, op: () => ({ operation: 'crop_video', parameters: { aspect: '16:9' } }) },
  { re: /\b4[:x\/]3\b/, op: () => ({ operation: 'crop_video', parameters: { aspect: '4:3' } }) },
  {
    re: /\b(?:letterbox|pillarbox|pad|fit (?:it )?(?:in)?to)\b/,
    op: (m, t) => ({ operation: 'pad_video', parameters: { aspect: /9[:x\/]16|vertical/.test(t) ? '9:16' : /1[:x\/]1|square/.test(t) ? '1:1' : '16:9' } }),
  },

  /* ---- trim ---- */
  {
    re: /\b(?:trim|cut|keep|take|use|clip|crop)\b.*\b(?:first|beginning|start)\b/,
    op: (m, t) => ({ operation: 'trim_video', parameters: { start: 0, duration: firstNum(t, 5) } }),
  },
  {
    re: /\b(?:trim|cut|keep|take|use|clip)\b.*\b(?:last|final|end)\b/,
    op: (m, t, ctx) => {
      const d = firstNum(t, 5);
      return { operation: 'trim_video', parameters: { start: Math.max(0, (ctx.duration || d) - d), duration: d } };
    },
  },
  {
    re: /\b(?:from|between)\s*(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)?\s*(?:to|-|until|till|through)\s*(\d+(?:\.\d+)?)/,
    op: (m) => ({ operation: 'trim_video', parameters: { start: parseFloat(m[1]), end: parseFloat(m[2]) } }),
  },
  {
    re: /\b(?:remove|cut|delete|drop|skip)\b.*\b(?:first|beginning|start|intro)\b/,
    op: (m, t, ctx) => {
      const n = firstNum(t, 3);
      return { operation: 'trim_video', parameters: { start: n, end: ctx.duration || undefined } };
    },
  },
  {
    re: /\b(?:remove|cut|delete|drop|skip)\b.*\b(?:last|end|ending|outro)\b/,
    op: (m, t, ctx) => {
      const n = firstNum(t, 3);
      return { operation: 'trim_video', parameters: { start: 0, end: Math.max(0.1, (ctx.duration || n * 2) - n) } };
    },
  },
  {
    re: /\b(?:trim|cut|shorten|clip)\b/,
    op: (m, t) => ({ operation: 'trim_video', parameters: { start: 0, duration: firstNum(t, 5) } }),
  },

  /* ---- speed ---- */
  {
    re: /\b(?:slow|slo-?mo|slow motion|slowmo)\b/,
    op: (m, t) => {
      const p = pct(t);
      let f = firstNum(t.replace(/\b(?:0\.\d+|\d+)\s*%/, ''), null);
      if (p) f = 1 / p;
      else if (f && f < 1) f = 1 / f;
      return { operation: 'slow_motion', parameters: { factor: f || 2 } };
    },
  },
  {
    re: /\b(?:speed|faster|fast forward|fast-forward|hurry|quick(?:er)?|sped|\d+(?:\.\d+)? times as fast|\d+x\b)\b/,
    op: (m, t) => {
      const p = pct(t);
      let f = firstNum(t, null);
      if (p && p > 0) f = 1 + p;
      return { operation: 'speed_up', parameters: { factor: f && f > 0 ? f : 2 } };
    },
  },
  { re: /\btime ?lapse\b|\bhyper ?lapse\b/, op: (m, t) => ({ operation: 'timelapse', parameters: { factor: firstNum(t, 8) } }) },

  /* ---- audio ---- */
  { re: /\b(?:mute|silence|remove (?:the )?(?:audio|sound)|no (?:audio|sound)|strip (?:the )?audio)\b/, op: () => ({ operation: 'mute_audio', parameters: {} }) },
  { re: /\b(?:extract|export|save|rip|get|pull)\b.*\b(?:audio|sound|mp3|music)\b/, op: () => ({ operation: 'extract_audio', parameters: {} }) },
  { re: /\b(?:normali[sz]e|even out|balance)\b.*\b(?:audio|sound|volume|loudness)\b|\bnormali[sz]e\b/, op: () => ({ operation: 'normalize_audio', parameters: {} }) },
  { re: /\b(?:clean|denoise|reduce noise|remove (?:background )?noise|noise reduction|hiss)\b/, op: () => ({ operation: 'denoise_audio', parameters: {} }) },
  { re: /\b(?:fade)\b.*\b(?:audio|sound|music)\b|\b(?:audio|sound|music)\b.*\bfade\b/, op: (m, t) => ({ operation: 'fade_audio', parameters: { type: /in\b/.test(t) && !/out/.test(t) ? 'in' : /out/.test(t) && !/in\b/.test(t) ? 'out' : 'both', duration: firstNum(t, 1) } }) },
  {
    re: /\b(?:volume|loud(?:er|ness)?|quiet(?:er)?|soft(?:er)?|audio level|turn it up|turn it down)\b/,
    op: (m, t) => {
      const p = pct(t);
      let lvl = p !== null ? (/\b(?:down|lower|quieter|reduce|decrease|softer)\b/.test(t) ? 1 - p : 1 + p) : firstNum(t, null);
      if (lvl === null) lvl = /\b(?:quiet|soft|lower|down|reduce|decrease)\b/.test(t) ? 0.5 : 1.5;
      if (/\bx\b|\btimes\b/.test(t) && lvl > 4) lvl = 2;
      return { operation: 'adjust_volume', parameters: { level: lvl } };
    },
  },

  /* ---- colour / looks ---- */
  { re: /\b(?:black and white|b\s*&\s*w|b\/w|bw|greyscale|grayscale|monochrome|mono)\b/, op: () => ({ operation: 'add_effect', parameters: { effect: 'grayscale' } }) },
  { re: /\bsepia\b/, op: () => ({ operation: 'add_effect', parameters: { effect: 'sepia' } }) },
  { re: /\b(?:cinematic|filmic|film look|movie look|like a movie|like a film|hollywood|teal and orange|make it pop|cinema)\b/, op: () => ({ operation: 'color_grade', parameters: { grade: 'cinematic' } }) },
  { re: /\bvintage|retro|old (?:film|school|timey)|nostalgi/, op: () => ({ operation: 'color_grade', parameters: { grade: 'vintage' } }) },
  { re: /\bnoir|high contrast b/, op: () => ({ operation: 'color_grade', parameters: { grade: 'noir' } }) },
  { re: /\bdramatic|moody|intense\b/, op: () => ({ operation: 'color_grade', parameters: { grade: 'dramatic' } }) },
  { re: /\bteal\b/, op: () => ({ operation: 'color_grade', parameters: { grade: 'teal' } }) },
  { re: /\bfaded|washed|matte\b/, op: () => ({ operation: 'color_grade', parameters: { grade: 'faded' } }) },
  { re: /\bwarm(?:er)?\b|\bwarm tone/, op: () => ({ operation: 'color_grade', parameters: { grade: 'warm' } }) },
  { re: /\bcool(?:er)?\b|\bcold(?:er)?\b|\bblue tone/, op: () => ({ operation: 'color_grade', parameters: { grade: 'cool' } }) },
  {
    re: /\bbright(?:er|en)?\b|\bdark(?:er|en)?\b|\bexposure\b/,
    op: (m, t) => {
      const dark = /\bdark|\bdim|\bunder ?expose/.test(t);
      const p = pct(t);
      const amt = p !== null ? p * 100 : firstNum(t, 25);
      return { operation: 'add_effect', parameters: { effect: 'brightness', intensity: dark ? 50 - amt / 2 : 50 + amt / 2 } };
    },
  },
  { re: /\bcontrast\b/, op: (m, t) => ({ operation: 'add_effect', parameters: { effect: 'contrast', intensity: /\b(?:less|lower|reduce|down|flat)\b/.test(t) ? 35 : 65 } }) },
  { re: /\b(?:saturat|vibran|colou?rful|vivid)/, op: (m, t) => ({ operation: 'add_effect', parameters: { effect: 'saturation', intensity: /\b(?:de|less|lower|reduce|down|mute)\b/.test(t) ? 30 : 70 } }) },
  { re: /\b(?:invert|negative|negate)\b/, op: () => ({ operation: 'add_effect', parameters: { effect: 'negate' } }) },
  { re: /\bhue\b|\bshift colou?rs?\b|\btint\b/, op: (m, t) => ({ operation: 'hue_rotate', parameters: { degrees: firstNum(t, 90) } }) },

  /* ---- effects ---- */
  { re: /\b(?:sharp(?:en|er)?|crisp(?:er)?|clear(?:er)?|enhance detail|unsharp)\b/, op: () => ({ operation: 'add_effect', parameters: { effect: 'sharpen' } }) },
  { re: /\bblur (?:the )?background\b|\bbackground blur\b/, op: () => ({ operation: 'blur_background', parameters: { aspect: '9:16' } }) },
  { re: /\b(?:blur|soften|out of focus|bokeh)\b/, op: (m, t) => ({ operation: 'add_effect', parameters: { effect: 'gblur', intensity: pct(t) !== null ? pct(t) * 100 : firstNum(t, 50) } }) },
  { re: /\b(?:pixel(?:ate|ated|ise|ize)?|censor|mosaic|8-?bit)\b/, op: (m, t) => ({ operation: 'add_effect', parameters: { effect: 'pixelate', intensity: firstNum(t, 16) } }) },
  { re: /\bvignette\b|\bdarken (?:the )?edges\b/, op: () => ({ operation: 'add_effect', parameters: { effect: 'vignette' } }) },
  { re: /\b(?:grain|noise|gritty)\b/, op: () => ({ operation: 'add_effect', parameters: { effect: 'noise' } }) },
  { re: /\b(?:denoise|smooth|clean up)\b/, op: () => ({ operation: 'add_effect', parameters: { effect: 'denoise' } }) },
  { re: /\bemboss\b/, op: () => ({ operation: 'add_effect', parameters: { effect: 'emboss' } }) },
  { re: /\bedge detect|outline|sketch\b/, op: () => ({ operation: 'add_effect', parameters: { effect: 'edge' } }) },
  { re: /\b(?:stabili[sz]e|steady|shaky|shake|smooth (?:out )?(?:the )?(?:motion|footage))\b/, op: () => ({ operation: 'stabilize', parameters: {} }) },

  /* ---- geometry ---- */
  {
    // A bare "1280x720" with no verb still clearly means resize.
    re: /\b(\d{2,5})\s*(?:x|by|\*)\s*(\d{2,5})\b/,
    op: (m) => ({ operation: 'resize_video', parameters: { width: +m[1], height: +m[2] } }),
  },
  {
    re: /\brotate\b|\bturn\b|\bsideways\b|\bupside ?down\b/,
    op: (m, t) => {
      let d = firstNum(t, null);
      if (/upside ?down/.test(t)) d = 180;
      if (d === null) d = /\b(?:left|counter|anti)\b/.test(t) ? 270 : 90;
      if (/\b(?:left|counter|anti)/.test(t) && d === 90) d = 270;
      return { operation: 'rotate', parameters: { degrees: ((Math.round(d / 90) * 90) % 360 + 360) % 360 || 90 } };
    },
  },
  { re: /\b(?:flip|mirror)\b/, op: (m, t) => ({ operation: 'flip', parameters: { direction: /\b(?:vertical|upside|top|bottom)\b/.test(t) ? 'vertical' : 'horizontal' } }) },
  {
    re: /\b(?:resi[sz]e|scale|shrink|enlarge|make it (?:bigger|smaller)|1080p?|720p?|480p?|4k)\b/,
    op: (m, t) => {
      if (/\b4k\b/.test(t)) return { operation: 'resize_video', parameters: { width: 3840, height: 2160 } };
      if (/\b1080p?\b/.test(t)) return { operation: 'resize_video', parameters: { width: 1920, height: 1080 } };
      if (/\b720p?\b/.test(t)) return { operation: 'resize_video', parameters: { width: 1280, height: 720 } };
      if (/\b480p?\b/.test(t)) return { operation: 'resize_video', parameters: { width: 854, height: 480 } };
      const dims = t.match(/(\d{2,5})\s*(?:x|by|\*)\s*(\d{2,5})/);
      if (dims) return { operation: 'resize_video', parameters: { width: +dims[1], height: +dims[2] } };
      const p = pct(t);
      if (p !== null) return { operation: 'scale_by', parameters: { factor: p } };
      return { operation: 'resize_video', parameters: { width: 1280, height: 720 } };
    },
  },
  { re: /\b(?:zoom|punch in)\b/, op: (m, t) => ({ operation: 'zoom', parameters: { factor: pct(t) !== null ? 1 + pct(t) : firstNum(t, 1.2) } }) },
  { re: /\b(?:border|frame it|outline it)\b/, op: (m, t) => ({ operation: 'add_border', parameters: { size: firstNum(t, 20), color: (t.match(/\b(white|black|red|blue|green|yellow|pink|purple|orange)\b/) || [])[1] || 'white' } }) },

  /* ---- transitions / motion ---- */
  {
    re: /\bfade\b/,
    op: (m, t) => ({
      operation: 'fade',
      parameters: {
        type: /\bin and out\b|\bboth\b/.test(t) ? 'both' : /\bout\b/.test(t) && !/\bin\b/.test(t) ? 'out' : /\bin\b/.test(t) && !/\bout\b/.test(t) ? 'in' : 'both',
        duration: firstNum(t, 1),
      },
    }),
  },
  { re: /\b(?:reverse|backward|rewind|play.*back(?:ward)?s)\b/, op: () => ({ operation: 'reverse', parameters: {} }) },
  { re: /\b(?:boomerang|ping ?pong|back and forth)\b/, op: () => ({ operation: 'boomerang', parameters: {} }) },
  { re: /\bloop\b|\brepeat\b/, op: (m, t) => ({ operation: 'loop_video', parameters: { count: Math.max(2, Math.round(firstNum(t, 2))) } }) },

  /* ---- text ---- */
  {
    re: /\b(?:add |put |write |overlay |insert )?(?:some )?(?:text|caption|title|subtitle|watermark|label)\b/,
    op: (m, t, ctx, raw) => {
      const q = raw.match(/["'“”']([^"'“”]{1,120})["'“”']/);
      let text = q ? q[1] : null;
      if (!text) {
        const said = raw.match(/\b(?:saying|that says|says|reading|with the words?|text)\s+(.+)$/i);
        text = said ? said[1].replace(/["'.]+$/, '').trim() : 'CutFlow';
      }
      const pos = /\btop\b/.test(t) ? 'top' : /\b(?:middle|centre|center)\b/.test(t) ? 'middle' : 'bottom';
      const colour = (t.match(/\b(white|black|red|blue|green|yellow|pink|purple|orange)\b/) || [])[1];
      return { operation: 'add_text', parameters: { text, position: pos, ...(colour ? { color: colour } : {}) } };
    },
  },

  /* ---- exports ---- */
  { re: /\b(?:gif|giphy)\b/, op: (m, t) => ({ operation: 'to_gif', parameters: { fps: firstNum(t, 12) } }) },
  { re: /\b(?:thumbnail|screenshot|still|poster|cover|snapshot|grab a frame|freeze frame)\b/, op: (m, t) => ({ operation: 'thumbnail', parameters: { time: firstNum(t, 0) } }) },
  { re: /\b(?:compress|smaller file|reduce (?:the )?(?:size|file)|optimi[sz]e|shrink the file|for (?:whatsapp|email)|file size|file smaller|make it smaller)\b/, op: (m, t) => ({ operation: 'compress', parameters: { level: /\b(?:a lot|heavy|max|hard|tiny)\b/.test(t) ? 'high' : 'medium' } }) },
  { re: /\b(?:fps|frame ?rate|frames per second|smooth(?:er)? playback|60 ?fps|30 ?fps|24 ?fps)\b/, op: (m, t) => ({ operation: 'change_fps', parameters: { fps: firstNum(t, 30) } }) },
];

/* ── public API ───────────────────────────────────────────────────────────── */

/**
 * Parse a natural-language command into one or more operations.
 * Returns { steps, matched, unmatched } — `steps` may be empty.
 */
export function parseCommand(raw, ctx = {}) {
  const text = normalise(raw);
  const clauses = splitClauses(text);
  const steps = [];
  const unmatched = [];

  for (const clause of clauses) {
    let hit = null;
    for (const rule of RULES) {
      const m = clause.match(rule.re);
      if (m) { hit = rule.op(m, clause, ctx, raw); break; }
    }
    if (hit && hit.operation) {
      // Collapse an exact duplicate of the previous step (e.g. "blur and blur").
      const prev = steps[steps.length - 1];
      if (!prev || prev.operation !== hit.operation ||
          JSON.stringify(prev.parameters) !== JSON.stringify(hit.parameters)) {
        steps.push(hit);
      }
    } else if (clause.trim()) {
      unmatched.push(clause.trim());
    }
  }

  return { steps, matched: steps.length > 0, unmatched };
}

/** Short human confirmation for a parsed plan. */
export function describeSteps(steps, labels = {}) {
  const names = steps.map((s) => {
    // "effect" tells the user nothing; name the actual effect/grade.
    const p = s.parameters || {};
    if (p.effect) return String(p.effect).replace(/_/g, ' ');
    if (p.grade) return `${p.grade} grade`;
    if (p.aspect) return `crop to ${p.aspect}`;
    return labels[s.operation] || s.operation.replace(/_/g, ' ');
  });
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

export const PARSER_RULE_COUNT = RULES.length;
