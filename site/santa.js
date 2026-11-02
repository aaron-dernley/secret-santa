// The cheeky-Santa ASCII reveal. Pure helpers are exported for tests; nothing
// touches the DOM until startReveal()/startMessage() is called.

// ---------- 3x5 block font (variable-width glyphs) ----------
export const GLYPHS = {
  A: [" █ ", "█ █", "███", "█ █", "█ █"],
  B: ["██ ", "█ █", "██ ", "█ █", "██ "],
  C: [" ██", "█  ", "█  ", "█  ", " ██"],
  D: ["██ ", "█ █", "█ █", "█ █", "██ "],
  E: ["███", "█  ", "██ ", "█  ", "███"],
  F: ["███", "█  ", "██ ", "█  ", "█  "],
  G: [" ██", "█  ", "█ █", "█ █", " ██"],
  H: ["█ █", "█ █", "███", "█ █", "█ █"],
  I: ["███", " █ ", " █ ", " █ ", "███"],
  J: ["  █", "  █", "  █", "█ █", " █ "],
  K: ["█ █", "█ █", "██ ", "█ █", "█ █"],
  L: ["█  ", "█  ", "█  ", "█  ", "███"],
  M: ["█   █", "██ ██", "█ █ █", "█   █", "█   █"],
  N: ["█  █", "██ █", "█ ██", "█  █", "█  █"],
  O: [" █ ", "█ █", "█ █", "█ █", " █ "],
  P: ["██ ", "█ █", "██ ", "█  ", "█  "],
  Q: [" █ ", "█ █", "█ █", "██ ", " ██"],
  R: ["██ ", "█ █", "██ ", "█ █", "█ █"],
  S: [" ██", "█  ", " █ ", "  █", "██ "],
  T: ["███", " █ ", " █ ", " █ ", " █ "],
  U: ["█ █", "█ █", "█ █", "█ █", "███"],
  V: ["█ █", "█ █", "█ █", "█ █", " █ "],
  W: ["█   █", "█   █", "█ █ █", "██ ██", "█   █"],
  X: ["█ █", "█ █", " █ ", "█ █", "█ █"],
  Y: ["█ █", "█ █", " █ ", " █ ", " █ "],
  Z: ["███", "  █", " █ ", "█  ", "███"],
  " ": ["  ", "  ", "  ", "  ", "  "],
  "!": ["█", "█", "█", " ", "█"],
  "-": ["   ", "   ", "███", "   ", "   "],
  "'": ["█", "█", " ", " ", " "],
  ".": [" ", " ", " ", " ", "█"],
  "&": [" █ ", "█ █", " █ ", "█ █", " ██"],
};
/** Upper-case and strip accents so "Zoë" renders as ZOE. */
export const norm = (s) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
/** Glyphs for a string; unknown characters render as a space. */
export const glyphs = (s) => [...norm(s)].map((c) => GLYPHS[c] || GLYPHS[" "]);
/** Width in columns of a string in block letters (1-column gap between glyphs). */
export const blockWidth = (s) =>
  glyphs(s).reduce((w, g, i) => w + g[0].length + (i ? 1 : 0), 0);

// ---------- sprites ----------
export const FRONT = [
  ["     _.._", "c-red"],
  ["   .'    '.*", "c-red"],
  ["  /________\\", "c-red"],
  ["  (________)", "c-fur"],
  ["   |EEEEEE|", "c-skin"],
  ["  (|  __  |)", "c-fur"],
  ["   \\ \\__/ /", "c-fur"],
  ["  .-'----'-.", "c-red"],
  [" /  | ## |  \\", "c-red"],
  [" \\__|_##_|__/", "c-red"],
  ["    | || |", "c-red"],
  ["   (__)(__)", "c-boot"],
];
export const MOON = [
  [" .~~~~~~~~~~~~~~~~~~~~~.", "c-fur"],
  [" (#####################)", "c-red"],
  [" '~~~~~~~~~~~~~~~~~~~~~'", "c-fur"],
  ["   .-'''''-. .-'''''-.", "c-skin"],
  ["  /         Y         \\", "c-skin"],
  [" |          |          |", "c-skin"],
  [" |          |          |", "c-skin"],
  ["  \\        / \\        /", "c-skin"],
  ["   '-.___.'   '.___.-'", "c-skin"],
  ["       |  |   |  |", "c-skin"],
  ["       |  |   |  |", "c-skin"],
  ["     ~~|~~|~~~|~~|~~", "c-fur"],
  ["     ##|##|###|##|##", "c-red"],
  ["       (__)   (__)", "c-boot"],
];
const WIGGLE_ROWS = 9; // coat + cheeks wiggle, legs stay planted

// Smallest scene that holds every frame. The reveal needs 40 columns for
// "CHRISTMAS" in block letters; the Santa scenes only need 28, so on a phone
// they get a bigger font and Santa fills the screen. 24 rows fits the
// mooning Santa under the captions.
export const REVEAL_COLS = 40;
export const SANTA_COLS = 28;
export const MIN_ROWS = 24;
const LINE_HEIGHT = 1.12, MAX_FONT = 24;
const T = { walk: 2.6, look: 5.6, flip: 8.0, reveal: 12.2 };

/** Word-wrap text to a width; "\n" forces a break. */
export function wrapText(str, width) {
  const lines = [];
  for (const para of str.split("\n")) {
    let cur = "";
    for (const w of para.split(" ")) {
      const next = cur ? cur + " " + w : w;
      if (cur && next.length > width) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    lines.push(cur);
  }
  return lines;
}

/** Split a name onto extra block-letter lines rather than overflow `maxCols`. */
export function wrapName(name, maxCols = REVEAL_COLS - 2) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? cur + " " + w : w;
    if (cur && blockWidth(next) > maxCols) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : ["???"];
}

// ---------- character grid ----------
function createGrid() {
  const g = { cols: REVEAL_COLS, rows: MIN_ROWS, ch: [], cl: [] };
  g.clear = () => {
    g.ch = new Array(g.cols * g.rows).fill(" ");
    g.cl = new Array(g.cols * g.rows).fill("");
  };
  // mode "trim": leading spaces transparent, rest opaque (sprites)
  // mode "clear": every space transparent; mode "solid": every space opaque (text, so snow can't fall through it)
  g.put = (x, y, str, cls, mode = "clear") => {
    if (y < 0 || y >= g.rows) return;
    const lead = mode === "trim" ? str.length - str.trimStart().length : 0;
    for (let i = 0; i < str.length; i++) {
      const c = str[i], xx = x + i;
      if (xx < 0 || xx >= g.cols) continue;
      if (c === " " && (mode === "clear" || i < lead)) continue;
      g.ch[y * g.cols + xx] = c;
      g.cl[y * g.cols + xx] = cls;
    }
  };
  g.center = (w) => Math.floor((g.cols - w) / 2);
  g.putCentered = (y, str, cls, mode = "solid") =>
    g.put(g.center(str.length), y, ` ${str} `, cls, mode);
  // Typewriter wrapped text: `shown` characters of the whole string are visible. Returns rows used.
  g.type = (y, str, cls, shown = Infinity) => {
    let left = shown;
    const lines = wrapText(str, g.cols - 2);
    lines.forEach((line, i) => {
      if (left > 0) g.putCentered(y + i, line.slice(0, left), cls);
      left -= line.length + 1;
    });
    return lines.length;
  };
  g.sprite = (spr, x, y, eyes, wiggle = 0) => {
    spr.forEach(([line, cls], r) => {
      const s = eyes ? line.replace("EEEEEE", eyes) : line;
      g.put(x + (r < WIGGLE_ROWS ? wiggle : 0), y + r, s, cls, "trim");
    });
  };
  // Block text revealed glyph-by-glyph; glyph plus trailing gap are solid so snow doesn't speckle the letters
  g.block = (text, y, clsFor, shown = Infinity) => {
    let x = g.center(blockWidth(text));
    glyphs(text).forEach((gl, i) => {
      if (i < shown) {
        for (let r = 0; r < 5; r++) {
          g.put(x, y + r, gl[r] + " ", clsFor(i), "solid");
        }
      }
      x += gl[0].length + 1;
    });
  };
  g.html = () => {
    const esc = (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c;
    let html = "";
    for (let y = 0; y < g.rows; y++) {
      let run = "", runCls = null;
      for (let x = 0; x < g.cols; x++) {
        const k = y * g.cols + x;
        if (g.cl[k] !== runCls) {
          if (run) {
            html += runCls ? `<span class="${runCls}">${run}</span>` : run;
          }
          run = "";
          runCls = g.cl[k];
        }
        run += esc(g.ch[k]);
      }
      if (run) html += runCls ? `<span class="${runCls}">${run}</span>` : run;
      if (y < g.rows - 1) html += "\n";
    }
    return html;
  };
  return g;
}

// Flakes live in 0..1 screen space so they carry on smoothly when the grid is resized between scenes
function createSnow() {
  const flakes = Array.from({ length: 140 }, () => ({
    x: Math.random(),
    y: Math.random(),
    v: 0.05 + Math.random() * 0.1,
    p: Math.random() * 6.28,
    c: ".·*+'"[Math.floor(Math.random() * 5)],
  }));
  return (g, dt, t, still) => {
    const n = Math.min(flakes.length, Math.round(g.cols * g.rows / 16));
    for (let i = 0; i < n; i++) {
      const f = flakes[i];
      if (!still) {
        f.y += f.v * dt;
        if (f.y >= 1) {
          f.y = 0;
          f.x = Math.random();
        }
      }
      g.put(
        Math.floor(f.x * g.cols + Math.sin(t * 1.3 + f.p) * 0.8),
        Math.floor(f.y * (g.rows - 1)),
        f.c,
        f.v > 0.11 ? "c-snow" : "c-dim",
      );
    }
    g.put(0, g.rows - 1, "~".repeat(g.cols), "c-dim");
  };
}

// Real advance width of one monospace cell, per px of font-size (fallback-font safe)
function cellRatio(screen) {
  const probe = document.createElement("span");
  probe.textContent = "█".repeat(50);
  probe.style.cssText =
    "position:absolute;visibility:hidden;white-space:pre;font-size:100px";
  probe.style.fontFamily = getComputedStyle(screen).fontFamily;
  document.body.appendChild(probe);
  const r = probe.getBoundingClientRect().width / 50 / 100;
  probe.remove();
  return r || 0.6;
}

function createFitter(stage, screen, grid) {
  let ratio = 0;
  return (needCols, needRows) => {
    const cs = getComputedStyle(stage);
    const w = stage.clientWidth - parseFloat(cs.paddingLeft) -
      parseFloat(cs.paddingRight);
    const h = stage.clientHeight - parseFloat(cs.paddingTop) -
      parseFloat(cs.paddingBottom);
    const cw = ratio || (ratio = cellRatio(screen));
    // Largest font where the scene's minimum grid fits both ways, then fill the leftover space with more sky
    const size = Math.min(
      MAX_FONT,
      w / (needCols * cw),
      h / (needRows * LINE_HEIGHT),
    );
    grid.cols = Math.max(needCols, Math.floor(w / (size * cw)));
    grid.rows = Math.max(needRows, Math.floor(h / (size * LINE_HEIGHT)));
    screen.style.fontSize = size.toFixed(2) + "px";
  };
}

/**
 * Play the reveal: Santa checks nobody's watching, moons the viewer, then
 * MERRY CHRISTMAS and the receiver's name in block letters. Tap skips to the
 * end; tap again replays. Respects prefers-reduced-motion.
 */
export function startReveal({ stage, screen, hint, giver, receiver }) {
  const g = createGrid();
  const snow = createSnow();
  const fitTo = createFitter(stage, screen, g);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nameLines = wrapName(receiver);
  const sayLine = `${giver},\nyou are Secret Santa for...`;
  // MERRY + gap + CHRISTMAS + gap + sentence + gap + name lines + sparkle row + footer
  const revealRows = 6 + 7 + wrapText(sayLine, REVEAL_COLS - 2).length + 1 +
    nameLines.length * 6 + 2;
  const need = {
    santa: [SANTA_COLS, MIN_ROWS],
    reveal: [
      Math.max(REVEAL_COLS, ...nameLines.map((l) => blockWidth(l) + 2)),
      Math.max(MIN_ROWS, revealRows + 2),
    ],
  };
  const nameStart = 1.8 + sayLine.length * 0.03 + 0.4;
  const finalEnd = T.reveal + nameStart + norm(receiver).length * 0.22 + 0.4;
  let scene = "santa", start, last, raf, skipped;
  const fit = () => fitTo(...need[scene]);
  const setScene = (s) => {
    if (s !== scene) {
      scene = s;
      fit();
    }
  };

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t = skipped
      ? Math.max((now - start) / 1000, finalEnd)
      : (now - start) / 1000;
    setScene(t < T.reveal ? "santa" : "reveal");
    g.clear();
    snow(g, dt, t, reduce);
    const ground = g.rows - 1;
    const top = Math.max(2, Math.floor(g.rows * 0.12));

    if (t < T.flip) {
      // Intro text + Santa walks on
      const used = g.type(
        top,
        `Psst... ${giver}!`,
        "c-bold",
        Math.floor(t / 0.06),
      );
      if (t > 1.0) {
        g.type(
          top + used,
          "Santa has a message\nfor you.",
          "c-snow",
          Math.floor((t - 1.0) / 0.035),
        );
      }
      const home = g.center(14);
      let x = home, eyes = " o  o ";
      if (t < T.walk) x = g.cols + 2;
      else if (t < T.look) {
        const k = (t - T.walk) / (T.look - T.walk);
        x = Math.round(
          g.cols + 2 - (g.cols + 2 - home) * (1 - Math.pow(1 - k, 2)),
        );
      } else {
        // pupils dart left and right while he checks nobody's watching
        const phase = Math.floor((t - T.look) / 0.45) % 4;
        eyes = phase === 1 ? "o  o  " : phase === 3 ? "  o  o" : " o  o ";
        g.putCentered(
          ground - FRONT.length - 2,
          t < 7.3 ? "...is anyone watching?" : "...good.",
          "c-snow",
        );
      }
      const bob = t >= T.walk && t < T.look && Math.floor(t / 0.22) % 2 === 0
        ? -1
        : 0;
      g.sprite(FRONT, x, ground - FRONT.length + bob, eyes);
    } else if (t < T.reveal) {
      // The moon
      const k = t - T.flip;
      const wig = [0, -1, 0, 1][Math.floor(k / 0.13) % 4];
      const x = g.center(25), y = ground - MOON.length;
      if (Math.floor(k / 0.32) % 2 === 0) {
        g.putCentered(top, "HO  HO  HO !", "c-bold");
      }
      g.type(
        top + 2,
        k < 1.4 ? "*  ta-daaa  *" : "MERRY CHRISTMAS\nfrom the North Pole",
        "c-snow",
      );
      g.sprite(MOON, x, y, null, wig);
      if (k > 1.8 && k < 3.0) {
        g.put(
          x + 13 + wig,
          y + 3 - Math.floor((k - 1.8) / 0.2),
          "~ toot! ~",
          "c-dim",
        );
      }
    } else {
      // The reveal, centred vertically in whatever height the phone has
      const k = t - T.reveal;
      let y = Math.max(1, Math.floor((g.rows - revealRows) / 2));
      g.block("MERRY", y, () => "c-red", Math.floor(k / 0.12) + 1);
      y += 6;
      g.block(
        "CHRISTMAS",
        y,
        (i) => (i % 2 ? "c-green" : "c-red"),
        Math.floor((k - 0.6) / 0.12) + 1,
      );
      y += 7;
      const sayRows = wrapText(sayLine, g.cols - 2).length;
      if (k > 1.8) g.type(y, sayLine, "c-snow", Math.floor((k - 1.8) / 0.03));
      y += sayRows + 1;
      let shownSoFar = Math.floor((k - nameStart) / 0.22) + 1;
      const nameTop = y;
      for (const line of nameLines) {
        if (k > nameStart) g.block(line, y, () => "c-gold", shownSoFar);
        shownSoFar -= glyphs(line).length + 1;
        y += 6;
      }
      const doneAt = nameStart + norm(receiver).length * 0.22;
      if (k > doneAt) {
        // twinkles on the rows just above and below the name, plus a cheeky callback in the corner
        for (let i = 0; i < 8; i++) {
          const sx = Math.floor(
            (Math.sin(t * 0.9 + i * 9.7) * 0.5 + 0.5) * (g.cols - 1),
          );
          g.put(
            sx,
            i % 2 ? nameTop - 1 : y - 1,
            Math.floor(t * 4 + i) % 2 ? "*" : "+",
            "c-gold",
          );
        }
        g.putCentered(y + 1, "shhh... keep it secret!", "c-dim");
        g.put(g.cols - 7, ground - 1, "(_Y_)", "c-skin");
      }
      if (k > doneAt + 0.2 && hint) hint.textContent = "tap to replay";
    }
    screen.innerHTML = g.html();
    raf = requestAnimationFrame(frame);
  }

  function play() {
    cancelAnimationFrame(raf);
    scene = "santa";
    fit();
    skipped = reduce;
    if (hint) hint.textContent = reduce ? "" : "tap to skip";
    start = last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  stage.addEventListener("click", () => {
    const t = (performance.now() - start) / 1000;
    if (skipped || t > finalEnd) play();
    else {
      skipped = true;
      if (hint) hint.textContent = "tap to replay";
    }
  });
  stage.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      stage.click();
    }
  });
  addEventListener("resize", fit);
  if (document.fonts?.ready) document.fonts.ready.then(fit);
  play();
  return { replay: play };
}

/** Show a short static message (e.g. a broken link) over falling snow. */
export function startMessage({ stage, screen, hint, lines }) {
  const g = createGrid();
  const snow = createSnow();
  const fitTo = createFitter(stage, screen, g);
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fit = () => fitTo(SANTA_COLS, MIN_ROWS);
  let last = performance.now();
  if (hint) hint.textContent = "";
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    g.clear();
    snow(g, dt, now / 1000, reduce);
    let y = Math.max(2, Math.floor(g.rows * 0.3));
    lines.forEach(([text, cls]) => {
      y += g.type(y, text, cls) + 1;
    });
    screen.innerHTML = g.html();
    requestAnimationFrame(frame);
  }
  addEventListener("resize", fit);
  if (document.fonts?.ready) document.fonts.ready.then(fit);
  fit();
  requestAnimationFrame(frame);
}
