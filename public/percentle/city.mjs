// The pixel-art city behind the game. It runs on the player's battery: every building has its own
// charge cut-off, so blocks of the city go dark one after another as the charge drains, and the
// stars come out as its glow fades. Supercharges strike it with lightning, a strong finish sets off
// fireworks, hard mode turns the night into a purple storm, and in endless mode the clock moves on
// each round (night, dawn, day, dusk, night again).
//
// Running out of charge blacks the city out (every building a dead silhouette), then the view
// rises up into the night sky above it: the Milky Way, nebulae, and a distant ringed planet
// (outOfCharge). The out-of-charge screen sits over that sky.
//
// Every drain sends a wave of dimming out through the windows from the middle of the skyline, and a supercharge sends a wave of
// light out from where the lightning hit.
//
// The scene is drawn once per screen width; after that, changing the charge only switches whole
// buildings on or off, and changing the time only updates a few colors and positions.

// The sky through a day: [hour, top color, horizon color, daylight 0-1]. In between, colors blend.
const SKY = [
  [0, "#03060b", "#0b1c26", 0],
  [4.5, "#04070f", "#0c1a2c", 0],
  [5.5, "#0b1433", "#3b2c52", 0.1],
  [6.25, "#22325e", "#b8774a", 0.4],
  [7.5, "#2f5a8e", "#b89a74", 0.8],
  [9, "#1f5c9c", "#5f8fb8", 1],
  [16, "#1f5c9c", "#5f8fb8", 1],
  [17.25, "#2e528a", "#b88a58", 0.8],
  [18.25, "#2c2f62", "#b45e3c", 0.45],
  [19.25, "#141b3e", "#4a3a6b", 0.15],
  [20.5, "#03060b", "#0b1c26", 0],
  [24, "#03060b", "#0b1c26", 0]
];
// Building silhouettes for the far, middle and near rows, at night and in daylight.
const BUILDINGS_NIGHT = ["#0b151b", "#081014", "#05090c"];
const BUILDINGS_DAY = ["#4a5b6e", "#36475a", "#243241"];
const BUILDINGS_HARD = ["#160c25", "#10081c", "#0a0512"];

const hex = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
function mix(a, b, t) {
  const [x, y] = [hex(a), hex(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

function skyAt(hour) {
  const h = ((hour % 24) + 24) % 24;
  for (let i = 1; i < SKY.length; i++) {
    const [h1, top1, bottom1, day1] = SKY[i - 1];
    const [h2, top2, bottom2, day2] = SKY[i];
    if (h <= h2) {
      const t = (h - h1) / (h2 - h1 || 1);
      return { top: mix(top1, top2, t), bottom: mix(bottom1, bottom2, t), day: day1 + (day2 - day1) * t };
    }
  }
  return { top: SKY[0][1], bottom: SKY[0][2], day: 0 };
}

// Seeded random numbers, so the skyline is the same every visit.
function random(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Where the moon is in its cycle at a moment: 0 new, 0.25 first quarter, 0.5 full, 0.75 last
// quarter. It counts lunar months (29.53 days on average) from a known new moon; the real sky can
// run up to about half a day either side of that average, which can't be seen at this size.
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);
const LUNAR_MONTH_DAYS = 29.530588853;
// The moon's darker "seas" (maria), roughly where they sit on the real moon's near side, as
// ellipses on a unit disc: [center x, center y, radius x, radius y], with y pointing down.
const MARIA = [
  [-0.35, -0.38, 0.27, 0.22], // Sea of Rains
  [-0.58, 0.05, 0.22, 0.38], // Ocean of Storms
  [0.12, -0.33, 0.15, 0.14], // Sea of Serenity
  [0.3, -0.04, 0.2, 0.17], // Sea of Tranquility
  [0.52, 0.22, 0.13, 0.15], // Sea of Fertility
  [0.68, -0.3, 0.1, 0.09], // Sea of Crises
  [-0.15, 0.42, 0.17, 0.12] // Sea of Clouds
];
// The bright young crater Tycho, near the bottom.
const TYCHO = [-0.12, 0.74, 0.13];

export function moonPhase(date = new Date()) {
  const months = (date.getTime() - KNOWN_NEW_MOON) / 86400000 / LUNAR_MONTH_DAYS;
  return ((months % 1) + 1) % 1;
}

export function createCity(root) {
  let level = 100;
  let hour = null; // null: the daily puzzle's fixed late night
  let buildings = [];
  let builtWidth = 0;
  let W = 0;
  let H = 0;
  let P = 3;
  let waveTimer = 0;
  let rising = false; // from the battery running out until the out-of-charge screen is up
  let heldLevel = null; // while the battery runs out, the lights stay at this level until they go out
  let storming = false; // an endless run ran out of charge in daylight: it ends in a storm
  const STORM_DAYLIGHT = 0.4; // how light the sky must be for that (about 6:15 AM to 6:15 PM)
  let PAN = 0; // how far the view rises
  let weatherKind = null; // "rain", "snow", "fog" or null
  let holiday = null; // "halloween", "december", "newyear", "july4" or null
  let snowLevel = 0; // 0 to 1: how much snow sits on the roofs
  let snowFalling = false;
  let billboard = null; // { x, y, w, h } once drawn
  let billboardText = ["CHARGLE", ""];
  const BILLBOARD_CUTOFF = 25; // the billboard's building loses power below this charge

  function build() {
    W = window.innerWidth;
    H = Math.max(window.innerHeight, 560);
    builtWidth = W;
    P = W < 600 ? 3 : 4;
    const phone = W < 600;
    const px = v => Math.round(v / P) * P;
    const r = random(7);
    let stars = "";
    for (let i = 0; i < (phone ? 70 : 150); i++) {
      const size = r() < 0.15 ? P : P / 1.5;
      stars += `<rect x="${px(r() * W)}" y="${px(r() * H * 0.62)}" width="${size}" height="${size}" fill-opacity="${(0.25 + r() * 0.75).toFixed(2)}"/>`;
    }
    // The moon as it really is tonight, and a pixel sun, drawn around (0, 0) and moved into place
    // later. Each pixel of the moon is lit or in shadow by the phase: a waxing moon is lit on the
    // right, a waning one on the left (as seen from the US), and the shadowed part shows faintly.
    // The lit part shows the darker seas and the bright crater Tycho.
    const moonR = phone ? 16 : 30;
    const phase = moonPhase();
    const terminator = Math.cos(2 * Math.PI * phase);
    let moon = "";
    for (let y = -moonR; y <= moonR; y += P) for (let x = -moonR; x <= moonR; x += P) {
      const cx = x + P / 2, cy = y + P / 2;
      if (cx * cx + cy * cy > moonR * moonR) continue;
      const edge = Math.sqrt(moonR * moonR - cy * cy) * terminator;
      const lit = phase < 0.5 ? cx >= edge : cx <= -edge;
      let kind = lit ? "moon-lit" : "moon-dark";
      if (lit) {
        const u = cx / moonR, v = cy / moonR;
        if (Math.hypot(u - TYCHO[0], v - TYCHO[1]) <= TYCHO[2]) kind = "moon-crater";
        else if (MARIA.some(([mx, my, rx, ry]) => ((u - mx) / rx) ** 2 + ((v - my) / ry) ** 2 <= 1)) kind = "moon-sea";
      }
      moon += `<rect class="${kind}" x="${x}" y="${y}" width="${P}" height="${P}"/>`;
    }
    const sunR = phone ? 11 : 24;
    let sun = `<circle r="${sunR * 3}" class="sun-glow"/>`;
    for (let y = -sunR; y <= sunR; y += P) for (let x = -sunR; x <= sunR; x += P) {
      if (x * x + y * y <= sunR * sunR) sun += `<rect x="${x}" y="${y}" width="${P}" height="${P}"/>`;
    }
    // Daytime pixel clouds, high in the sky. Phones have no open sky beside the game, so none there.
    const cr = random(41);
    let clouds = "";
    for (let c = 0; c < (phone ? 0 : 8); c++) {
      const cx = cr() * W, cy = H * (0.01 + cr() * 0.1), cw = W * (phone ? 0.3 : 0.14) * (0.7 + cr() * 0.6);
      for (let i = 0; i < 5; i++) {
        clouds += `<rect x="${px(cx - cw / 2 + cr() * cw * 0.5)}" y="${px(cy + cr() * 12)}" width="${px(cw * (0.3 + cr() * 0.5))}" height="${px(10 + cr() * 14)}"/>`;
      }
    }
    // Hard mode's storm: low clouds and rain.
    const sr = random(31);
    let storm = "";
    for (let c = 0; c < (phone ? 5 : 9); c++) {
      const cx = sr() * W, cy = H * sr() * 0.1, cw = W * (0.25 + sr() * 0.25);
      for (let i = 0; i < 7; i++) {
        storm += `<rect x="${px(cx - cw / 2 + sr() * cw * 0.6)}" y="${px(cy + sr() * 18)}" width="${px(cw * (0.3 + sr() * 0.5))}" height="${px(14 + sr() * 22)}"/>`;
      }
    }
    let rain = "";
    for (let i = 0; i < (phone ? 60 : 140); i++) rain += `<rect x="${px(sr() * W)}" y="${px(sr() * H)}" width="1" height="${P * 4}"/>`;

    // A pylon at the edge of the skyline.
    const pylonX = px(W * 0.04), pylonTop = px(H * (phone ? 0.86 : 0.76));
    let pylon = `<rect x="${pylonX - 16}" y="${pylonTop}" width="${32 + P}" height="${P}"/>`;
    for (let y = pylonTop; y < H; y += P) {
      const half = px(2 + ((y - pylonTop) / (H - pylonTop)) * 12);
      pylon += `<rect x="${pylonX - half}" y="${y}" width="${P}" height="${P}"/><rect x="${pylonX + half}" y="${y}" width="${P}" height="${P}"/>`;
      if ((y / P) % 4 === 0) pylon += `<rect x="${pylonX - half}" y="${y}" width="${half * 2 + P}" height="${P / 1.5}"/>`;
    }

    // Three rows of buildings. Each building's windows are one group with its own cut-off.
    const layers = [
      { top: 0.74, minH: 0.07, maxH: 0.16, win: 0.45, w: [26, 54], seed: 3 },
      { top: 0.8, minH: 0.06, maxH: 0.17, win: 0.75, w: [30, 64], seed: 11 },
      { top: 0.88, minH: 0.04, maxH: 0.1, win: 0.95, w: [34, 80], seed: 23 }
    ];
    const scale = phone ? 0.62 : 1;
    const dim = phone ? 0.62 : 0.85;
    let city = "";
    const layout = []; // each building's place, in the same order as its windows group
    // A few windows start dark, so there are some to switch on (see the window flicker below).
    const wr = random(77);
    layers.forEach((layer, n) => {
      const lr = random(layer.seed);
      const base = H - (H - H * (layer.top + 0.12)) * scale;
      let shapes = "", lights = "", beacons = "";
      const placed = [];
      let antennas = 0;
      let x = -px(10);
      while (x < W) {
        const bw = px(layer.w[0] + lr() * (layer.w[1] - layer.w[0]));
        const bh = px(H * scale * (layer.minH + lr() * (layer.maxH - layer.minH)));
        const by = px(base - bh);
        const cutoff = (lr() * 100).toFixed(1);
        shapes += `<rect x="${x}" y="${by}" width="${bw}" height="${H - by}"/>`;
        if (lr() < 0.5) shapes += `<rect x="${x + px(bw * 0.2)}" y="${by - P * 2}" width="${px(bw * 0.6)}" height="${P * 2}"/>`;
        if (lr() < 0.35) {
          const ax = x + px(bw / 2);
          shapes += `<rect x="${ax}" y="${by - P * 7}" width="${P / 1.5}" height="${P * 7}"/>`;
          // Only every other antenna carries a warning light, so they stay a quiet detail.
          if (antennas++ % 2 === 0) beacons += `<rect x="${ax - 1}" y="${by - P * 8}" width="${P}" height="${P}"/>`;
        }
        let windows = "";
        const cols = Math.max(1, Math.floor((bw - P * 2) / (P * 3)));
        for (let wy = by + P * 2; wy < H - P * 2; wy += P * 3) {
          for (let c = 0; c < cols; c++) {
            if (lr() >= 0.8) continue;
            const kind = lr() < 0.02 ? "wn" : `w${Math.floor(lr() * 3)}`;
            windows += `<rect class="${kind}${wr() < 0.06 ? " dark" : ""}" x="${x + P + c * P * 3}" y="${wy}" width="${P}" height="${P * 1.5}" fill-opacity="${(layer.win * dim * (0.55 + lr() * 0.45)).toFixed(2)}"/>`;
          }
        }
        lights += `<g class="bw" data-cutoff="${cutoff}">${windows}</g>`;
        placed.push({ x, w: bw, top: by, row: n });
        // Buildings stand shoulder to shoulder: a gap between two would show the glowing sky behind
        // as a bright slit, like a beam of light. (The draw still runs so the skyline stays the same.)
        lr();
        x += bw;
      }
      layout.push(...placed);
      city += `<g class="row row-${n}">${shapes}</g><g class="lights">${lights}</g><g class="beacons">${beacons}</g>`;
    });

    // Snow caps on every roof, grown by --snow (0 to 1) when it snows or a winter endless run goes on.
    city += `<g class="snow-caps">${layout.map(b => `<rect x="${b.x}" y="${b.top - P * 2}" width="${b.w}" height="${P * 2}"/>`).join("")}</g>`;

    // December: strings of colored lights along some rooftops (shown with .december).
    const hl = random(61);
    let strings = "";
    for (const roof of layout.filter(b => b.row > 0 && b.w > P * 8)) {
      if (hl() > 0.55) continue;
      for (let x = roof.x + P; x < roof.x + roof.w - P; x += P * 2) {
        const sag = Math.sin(((x - roof.x) / roof.w) * Math.PI) * P * 1.5;
        strings += `<rect class="hl hl-${Math.floor(hl() * 4)}" x="${x}" y="${(roof.top + P + sag).toFixed(0)}" width="${P}" height="${P}"/>`;
      }
    }
    city += `<g class="holiday-lights">${strings}</g>`;

    // Halloween: a few bats fluttering in open sky (shown with .halloween).
    const batSpots = phone ? [[0.22, 0.19], [0.86, 0.2], [0.62, 0.15]] : [[0.12, 0.22], [0.2, 0.34], [0.86, 0.3], [0.08, 0.42]];
    const bat = (bx, by, k) => `<g class="bat" style="--bx:${bx.toFixed(0)}px;--by:${by.toFixed(0)}px;animation-delay:-${(k * 1.7).toFixed(1)}s">
        <g class="bat-up">${[[-6, 0, 4, 1], [-4, -1, 2, 1], [-1, 0, 2, 2], [2, 0, 4, 1], [2, -1, 2, 1]].map(([x, y, w, h]) => `<rect x="${x * P}" y="${y * P}" width="${w * P}" height="${h * P}"/>`).join("")}</g>
        <g class="bat-down">${[[-6, 1, 2, 1], [-4, 0, 3, 1], [-1, 0, 2, 2], [1, 0, 3, 1], [4, 1, 2, 1]].map(([x, y, w, h]) => `<rect x="${x * P}" y="${y * P}" width="${w * P}" height="${h * P}"/>`).join("")}</g></g>`;
    city += `<g class="bats">${batSpots.map(([fx, fy], k) => bat(W * fx, H * fy, k)).join("")}</g>`;

    // A lit billboard on a rooftop on the right, on two posts standing on the roof. It's drawn
    // once at the origin and moved onto a roof
    // by placeBillboard: the tallest one on the right that the game doesn't cover. Its words come
    // from setBillboard (the player's streak, or the puzzle number).
    const bw = px(phone ? 60 : 104), bh = px(phone ? 24 : 34);
    // Roofs wide enough to hold it (at least 60% of its width), with the sign fully on screen.
    const fits = b => b.w >= bw * 0.6 && b.x + b.w / 2 - bw / 2 > 4 && b.x + b.w / 2 + bw / 2 < W - 4;
    billboard = { w: bw, h: bh, roofs: layout.filter(fits).sort((x, y) => x.top - y.top), walls: layout.filter(b => b.w >= bw + P * 2 && b.x >= 0 && b.x + b.w <= W).sort((x, y) => y.row - x.row) };
    let bulbs = "";
    for (let x = P * 2, k = 0; x < bw - P; x += P * 3, k++) {
      bulbs += `<rect class="bulb bulb-${k % 2}" x="${x}" y="${P}" width="${P}" height="${P}"/><rect class="bulb bulb-${(k + 1) % 2}" x="${x}" y="${bh - P * 2}" width="${P}" height="${P}"/>`;
    }
    city += `<g class="billboard">
        <g class="bb-legs"><rect class="bb-post bb-post-l" y="${bh}" width="${P}" height="${P * 3}"/><rect class="bb-post bb-post-r" y="${bh}" width="${P}" height="${P * 3}"/>
        <rect class="bb-brace" y="${bh + P}" height="${P}"/><rect class="bb-spill" y="${bh + P * 3 - 1}" height="2"/></g>
        <rect class="bb-frame" x="0" y="0" width="${bw}" height="${bh}"/>${bulbs}
        <text class="bb-1" x="${bw / 2}" y="${(bh * 0.47).toFixed(1)}" font-size="${phone ? 7 : 10}"></text>
        <text class="bb-2" x="${bw / 2}" y="${(bh * 0.72).toFixed(1)}" font-size="${phone ? 6 : 9}"></text></g>`;

    // Weather over the city, drawn once and shown by class: rain and snow fall in endless loops
    // (two copies of the same tile, one above the other), and fog drifts low over the skyline.
    const wx = random(83);
    let rainTile = "", snowTile = "";
    for (let i = 0; i < (phone ? 80 : 180); i++) {
      const x = wx() * (W + 40) - 20, y = wx() * H;
      rainTile += `<line x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${(x - 4).toFixed(0)}" y2="${(y + 14).toFixed(0)}" stroke-opacity="${(0.25 + wx() * 0.4).toFixed(2)}"/>`;
    }
    for (let i = 0; i < (phone ? 90 : 210); i++) {
      snowTile += `<rect x="${px(wx() * W)}" y="${px(wx() * H)}" width="${P}" height="${P}" fill-opacity="${(0.45 + wx() * 0.5).toFixed(2)}"/>`;
    }
    const skylineTop = Math.min(...layout.filter(b => b.row === 0).map(b => b.top));
    const fog = [0.2, 0.55, 0.85].map((f, i) => `<ellipse class="fog fog-${i}" cx="${(W * f).toFixed(0)}" cy="${(skylineTop + H * 0.06).toFixed(0)}" rx="${(W * 0.42).toFixed(0)}" ry="${(H * 0.07).toFixed(0)}" fill="url(#fogPuff)"/>`).join("");
    const weather = `<svg class="city-weather" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">
        <defs><radialGradient id="fogPuff"><stop offset="0" stop-color="#cdd6e0" stop-opacity=".2"/><stop offset="1" stop-color="#cdd6e0" stop-opacity="0"/></radialGradient></defs>
        <g class="wx-rain"><g class="wx-fall" style="--tile:${H}px">${rainTile}<g transform="translate(0 ${-H})">${rainTile}</g></g></g>
        <g class="wx-snow"><g class="wx-fall" style="--tile:${H}px">${snowTile}<g transform="translate(0 ${-H})">${snowTile}</g></g></g>
        <g class="wx-fog">${fog}</g>
      </svg>`;

    // The sky above the view, seen when it rises after the battery runs out.
    PAN = Math.round(H * 0.8);
    const sky = random(57);
    let deepStars = "";
    for (let i = 0; i < (phone ? 110 : 260); i++) {
      const size = sky() < 0.12 ? P : P / 1.5;
      deepStars += `<rect x="${px(sky() * W)}" y="${px(sky() * PAN)}" width="${size}" height="${size}" fill-opacity="${(0.3 + sky() * 0.7).toFixed(2)}"/>`;
    }
    // The Milky Way: a soft diagonal band of faint stars and glow.
    let galaxy = "";
    for (let i = 0; i < (phone ? 220 : 520); i++) {
      const t = sky();
      const spread = (sky() + sky() + sky() - 1.5) * PAN * 0.16;
      const gx = t * W, gy = PAN * 0.92 - t * PAN * 0.8 + spread;
      galaxy += `<rect x="${px(gx)}" y="${px(gy)}" width="${P / 1.5}" height="${P / 1.5}" fill-opacity="${(0.15 + sky() * 0.5).toFixed(2)}"/>`;
    }
    // A ringed planet in open sky (beside the game on a wide screen), lit from the left, with a moon.
    const R = phone ? 30 : 56;
    const gutter = (W - 720) / 2;
    const planetX = phone ? W * 0.74 : gutter > R * 3.2 ? W - gutter / 2 : W * 0.86;
    const planetY = PAN * (phone ? 0.3 : 0.42);
    const bands = ["#7fb8c9", "#9fd0db", "#6aa2b8", "#b8e0e4", "#5b8fa8", "#8cc4d1"];
    const ringPixel = (back) => {
      let out = "";
      for (let a = 0; a < 360; a += 2) {
        const ang = a * Math.PI / 180;
        for (const k of [1.55, 1.75, 1.95]) {
          const rx = Math.cos(ang) * R * k, ry = Math.sin(ang) * R * k * 0.28;
          const x = rx * 0.97 - ry * 0.26, y = rx * 0.26 + ry * 0.97; // tilted
          if ((ry < 0) !== back) continue;
          out += `<rect x="${px(x)}" y="${px(y)}" width="${P}" height="${P}" fill-opacity="${k === 1.75 ? 0.9 : 0.55}"/>`;
        }
      }
      return out;
    };
    let planet = "";
    for (let y = -R; y <= R; y += P) for (let x = -R; x <= R; x += P) {
      if (x * x + y * y > R * R) continue;
      const band = bands[Math.floor(((y / R + 1) / 2) * bands.length * 1.5) % bands.length];
      const light = 0.45 + 0.55 * Math.max(0, (-x / R) * 0.7 + 0.5 - Math.hypot(x, y) / R * 0.25);
      planet += `<rect x="${x}" y="${y}" width="${P}" height="${P}" fill="${band}" fill-opacity="${Math.min(1, light).toFixed(2)}"/>`;
    }
    const mr = Math.round(R * 0.2);
    const moonlet = `<g transform="translate(${(-R * 2.4).toFixed(0)} ${(-R * 1.2).toFixed(0)})"><circle r="${mr}"/><circle r="${mr}" cx="${(mr * 0.45).toFixed(1)}" fill="#02050c" opacity=".55"/></g>`;
    const space = `<svg class="city-space" viewBox="0 0 ${W} ${PAN}" preserveAspectRatio="none" style="height:${PAN}px;top:-${PAN}px">
        <defs>
          <linearGradient id="spaceFade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#010208"/><stop offset=".7" stop-color="#02050c" stop-opacity=".6"/><stop offset="1" stop-color="#02050c" stop-opacity="0"/></linearGradient>
          <radialGradient id="nebulaA"><stop offset="0" stop-color="#8a5cff" stop-opacity=".22"/><stop offset="1" stop-color="#8a5cff" stop-opacity="0"/></radialGradient>
          <radialGradient id="nebulaB"><stop offset="0" stop-color="#3fa9d9" stop-opacity=".18"/><stop offset="1" stop-color="#3fa9d9" stop-opacity="0"/></radialGradient>
          <radialGradient id="planetGlow"><stop offset=".55" stop-color="#9fd0db" stop-opacity=".18"/><stop offset="1" stop-color="#9fd0db" stop-opacity="0"/></radialGradient>
        </defs>
        <rect width="${W}" height="${PAN}" fill="url(#spaceFade)"/>
        <ellipse cx="${(W * 0.3).toFixed(0)}" cy="${(PAN * 0.55).toFixed(0)}" rx="${(W * 0.45).toFixed(0)}" ry="${(PAN * 0.22).toFixed(0)}" fill="url(#nebulaA)"/>
        <ellipse cx="${(W * 0.62).toFixed(0)}" cy="${(PAN * 0.32).toFixed(0)}" rx="${(W * 0.35).toFixed(0)}" ry="${(PAN * 0.18).toFixed(0)}" fill="url(#nebulaB)"/>
        <g class="galaxy">${galaxy}</g>
        <g class="deep-stars">${deepStars}</g>
        <g class="planet" transform="translate(${planetX.toFixed(0)} ${planetY.toFixed(0)})">
          <circle r="${R * 1.6}" fill="url(#planetGlow)"/>
          <g class="planet-ring">${ringPixel(true)}</g>
          <g class="planet-body">${planet}</g>
          <g class="planet-ring">${ringPixel(false)}</g>
          <g class="planet-moon">${moonlet}</g>
        </g>
        <path class="shooting-star" d="M${(W * 0.15).toFixed(0)},${(PAN * 0.18).toFixed(0)} l${(W * 0.12).toFixed(0)},${(PAN * 0.06).toFixed(0)}"/>
      </svg>`;

    // An endless run that runs out of charge in daylight ends in a storm instead of in space
    // (storm-out): a front of heavy pixel clouds rolls in over the top of the city, and above it, where
    // the view rises to, a sky full of storm clouds with lightning flickering inside them.
    const cloudBank = (width, top, height, count, seed) => {
      const cr = random(seed);
      const shades = ["#2a2f37", "#343a44", "#3f4651", "#4b535f"];
      let out = "";
      for (let i = 0; i < count; i++) {
        const cx = cr() * width, cy = top + cr() * height, cw = width * (phone ? 0.35 : 0.18) * (0.8 + cr() * 0.9);
        const rows = 3 + Math.floor(cr() * 4), rh = px(8 + cr() * 10);
        for (let k = 0; k < rows; k++) {
          const t = k / (rows - 1); // 0 at the top of the cloud, 1 at its base
          const ww = cw * (0.45 + 0.55 * Math.sin(Math.PI * (0.2 + t * 0.6)));
          out += `<rect x="${px(cx - ww / 2 + (cr() - 0.5) * P * 6)}" y="${px(cy + k * rh)}" width="${px(ww)}" height="${rh}" fill="${shades[Math.min(3, Math.floor((1 - t) * 3.5))]}"/>`;
        }
      }
      return out;
    };
    const stormFront = `<svg class="storm-front" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">${cloudBank(W, -H * 0.05, H * 0.2, phone ? 12 : 22, 91)}</svg>`;
    const flickers = [[0.2, 0.3, 0], [0.72, 0.55, -2.3], [0.45, 0.78, -4.1], [0.85, 0.18, -5.6]]
      .map(([fx, fy, delay]) => `<div class="storm-flicker" style="left:${(fx * 100).toFixed(0)}%;top:${(fy * 100).toFixed(0)}%;animation-delay:${delay}s"></div>`).join("");
    const stormSky = `<div class="city-stormsky" style="height:${PAN}px;top:-${PAN}px">${flickers}
        <svg viewBox="0 0 ${W} ${PAN}" preserveAspectRatio="none">${cloudBank(W, -PAN * 0.05, PAN * 1.05, phone ? 26 : 46, 97)}</svg></div>`;
    // Rain over the whole screen in the storm: one tile of streaks, repeated and slid down endlessly.
    const rr = random(101);
    let streaks = "";
    for (let i = 0; i < 14; i++) {
      const x = rr() * 160, y = rr() * 160;
      streaks += `<line x1='${x.toFixed(0)}' y1='${y.toFixed(0)}' x2='${(x - 4).toFixed(0)}' y2='${(y + 16).toFixed(0)}'/>`;
    }
    const rainTileUrl = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' stroke='#b4c2d4' stroke-opacity='.55' stroke-width='1.3'>${streaks}</svg>`).replace(/'/g, "%27")}")`;

    root.innerHTML = `<div class="city-sky"></div><div class="city-world"><div class="city-glow"></div>
      <svg class="city-scene" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">
        <defs><radialGradient id="sunGlow"><stop offset="0" stop-color="#ffd86b" stop-opacity=".35"/><stop offset="1" stop-color="#ffd86b" stop-opacity="0"/></radialGradient></defs>
        <g class="stars">${stars}</g>
        <g class="sun">${sun}</g>
        <g class="moon">${moon}</g>
        <g class="clouds">${clouds}</g>
        <g class="storm"><g class="storm-clouds">${storm}</g><g class="rain">${rain}</g></g>
        <g class="pylon">${pylon}</g>
        ${city}
      </svg>
      ${weather}
      ${stormFront}
      ${space}
      ${stormSky}</div>
      <div class="city-storm-rain" style='background-image:${rainTileUrl}'></div>
      <div class="city-scan"></div>`;
    buildings = [...root.querySelectorAll(".bw")].map((el, i) => ({ el, cutoff: Number(el.dataset.cutoff), ...layout[i] }));
    root.style.setProperty("--pan", `${PAN}px`);
    showBillboard();
    placeBillboard();
    // Place the moon and sun without gliding in from the corner.
    root.classList.add("placing");
    refresh();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("placing")));
  }

  function refresh() {
    const body = document.body;
    const hard = body.classList.contains("hard");
    // On the start screen the city is dark: nothing powers it until the battery charges up on Play.
    // In the game it shows the real charge.
    const shown = body.classList.contains("starting") ? 0 : Math.max(0, Math.min(100, heldLevel ?? level));
    const out = shown <= 0;
    for (const building of buildings) building.el.classList.toggle("on", building.cutoff < shown);
    root.classList.toggle("out", out);
    root.classList.toggle("low", shown > 0 && shown < 20);
    const sky = skyAt(hour ?? 0);
    if (body.classList.contains("dead")) {
      rising = false;
      // Reloading an endless run that ran out in daylight shows its storm again.
      if (hour !== null && sky.day >= STORM_DAYLIGHT) storming = true;
    } else if (!rising) {
      heldLevel = null;
      storming = false;
      root.classList.remove("blackout", "skyward");
    }
    root.classList.toggle("storm-out", storming);

    const night = 1 - sky.day;
    root.classList.toggle("day", sky.day > 0.01);
    let top = sky.top, bottom = sky.bottom;
    if (hard) {
      top = mix(top, "#0d0418", 0.6);
      bottom = mix(bottom, "#3a1a5c", 0.55);
    }
    // Rain, snow and fog hang grey cloud over the sky and hide most of the stars.
    const overcast = Boolean(weatherKind);
    if (overcast) {
      top = mix(top, "#1b232d", 0.45);
      bottom = mix(bottom, "#2b3440", 0.35);
    }
    if (storming) {
      top = mix(top, "#1c2027", 0.85);
      bottom = mix(bottom, "#3a414c", 0.8);
    }
    if (out) {
      top = mix(top, "#000000", 0.4 * night);
      bottom = mix(bottom, "#000000", 0.5 * night);
    }
    root.classList.toggle("weather-rain", weatherKind === "rain" && !storming);
    root.classList.toggle("weather-snow", weatherKind === "snow" || snowFalling);
    root.classList.toggle("weather-fog", weatherKind === "fog");
    for (const name of ["halloween", "december", "newyear", "july4"]) root.classList.toggle(name, holiday === name);
    root.style.setProperty("--snow", String(snowLevel));
    root.querySelector(".billboard")?.classList.toggle("on", shown > BILLBOARD_CUTOFF);
    const rows = hard ? BUILDINGS_HARD : BUILDINGS_NIGHT;
    // These run while the battery animates (every frame), so a variable on the whole city is only
    // touched when its value really changes: a change restyles every pixel in the city. The stars
    // and glow follow the charge itself, so they're set straight on their own elements.
    const set = (name, value) => { if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value); };
    set("--sky-top", top);
    set("--sky-bottom", bottom);
    rows.forEach((color, i) => set(`--row-${i}`, mix(color, BUILDINGS_DAY[i], hard ? sky.day * 0.5 : sky.day)));
    set("--windows", (1 - sky.day * 0.7).toFixed(3));
    set("--daylight", sky.day.toFixed(3));
    const stars = root.querySelector(".stars"), glow = root.querySelector(".city-glow");
    if (stars) stars.style.opacity = (night * (0.25 + (1 - shown / 100) * 0.75) * (overcast ? 0.15 : 1)).toFixed(2);
    if (glow) glow.style.opacity = out ? "0" : (night * (0.25 + (shown / 100) * 0.75)).toFixed(2);

    // The moon and sun cross the sky, gliding from spot to spot (see .moon/.sun in percentle.css).
    const moon = root.querySelector(".moon");
    const sun = root.querySelector(".sun");
    if (!moon || !sun) return;
    if (hour === null) {
      // The daily puzzle's moon keeps its own fixed spot: top right on a wide screen, top left
      // beside the edition line on a phone.
      const phone = W < 600;
      place(moon, { x: W * (phone ? 0.075 : 0.84), y: H * (phone ? 0.125 : 0.12) });
      place(sun, sunSpot(21));
      return;
    }
    const h = ((hour % 24) + 24) % 24;
    place(moon, moonSpot(h));
    place(sun, sunSpot(h));
  }

  // Moves the moon or sun to a spot. Small moves glide straight there (the CSS transition); a long
  // trip across the sky, like the moon's when Endless starts, follows a low rainbow arc instead,
  // peaking a little below the top of the screen so it never leaves it.
  const lastSpot = new WeakMap();
  function place(el, to) {
    const from = lastSpot.get(el);
    // Already there (refresh runs every frame while the battery animates): nothing to do.
    if (from && from.x === to.x && from.y === to.y && !root.classList.contains("placing")) return;
    lastSpot.set(el, to);
    const at = p => `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    // Once it has set off the right edge, it comes back round out of sight: an instant jump from
    // beyond the right edge to beyond the left, where it will rise from next.
    if (from && from.x > W && to.x < from.x) {
      el.getAnimations().forEach(animation => animation.cancel());
      el.style.transition = "none";
      el.style.transform = at(to);
      el.getBoundingClientRect();
      requestAnimationFrame(() => { el.style.transition = ""; });
      return;
    }
    const far = from && Math.abs(to.x - from.x) > W * 0.3;
    if (!far || reducedMotion() || root.classList.contains("placing") || !el.animate) {
      el.style.transform = at(to);
      return;
    }
    const margin = (W < 600 ? 16 : 30) + 12; // the moon's radius, plus a little sky above it
    const peak = Math.max(margin, Math.min(from.y, to.y) - H * 0.07);
    const control = { x: (from.x + to.x) / 2, y: (4 * peak - from.y - to.y) / 2 };
    const frames = Array.from({ length: 31 }, (_, i) => {
      const t = i / 30, u = 1 - t;
      return { transform: at({ x: u * u * from.x + 2 * u * t * control.x + t * t * to.x, y: u * u * from.y + 2 * u * t * control.y + t * t * to.y }) };
    });
    el.getAnimations().forEach(animation => animation.cancel());
    el.style.transition = "none"; // the arc animation does the moving; the CSS glide would fight it
    el.style.transform = at(to);
    el.animate(frames, { duration: 2000, easing: "cubic-bezier(.45,0,.25,1)" }).finished
      .then(() => { el.style.transition = ""; })
      .catch(() => {});
  }

  // Where the endless moon is at an hour. Every run starts at 9 PM with the moon in the top left, so
  // pressing Endless glides it across the sky from the daily spot. From 6 PM it rises in from beyond
  // the left edge to that spot; through the night it drifts across the sky, a little higher around
  // midnight, and sets past the right edge by dawn. Through the day it waits beyond the left edge.
  function moonSpot(h) {
    const phone = W < 600;
    const nine = { x: W * (phone ? 0.075 : 0.16), y: H * (phone ? 0.125 : 0.12) };
    const rise = { x: -80, y: H * 0.34 };
    const since = (h - 18 + 24) % 24; // hours since 6 PM
    if (since > 12) return rise;
    if (since <= 3) {
      const t = 1 - (1 - since / 3) ** 2;
      return { x: rise.x + (nine.x - rise.x) * t, y: rise.y + (nine.y - rise.y) * t };
    }
    const t = (since - 3) / 9; // 9 PM to 6 AM
    return { x: nine.x + (W + 80 - nine.x) * t, y: nine.y - H * 0.05 * Math.sin(Math.PI * t) + (H * 0.36 - nine.y) * t * t };
  }

  // Where the sun is at an hour: coming in past the left edge at 6 AM, highest at noon, and gone
  // past the right edge at 6 PM. At night it waits beyond the left edge, where it rises next.
  function sunSpot(h) {
    const t = (h - 6) / 12;
    if (t < 0 || t > 1) return { x: -80, y: H * 0.4 };
    return { x: -80 + (W + 160) * t, y: H * (0.4 - 0.34 * Math.sin(Math.PI * t)) };
  }

  // A wave through the windows, rippling out from a point on the skyline (the middle by default).
  // "down" dims every lit window as it passes, and the buildings losing power go dark in the same
  // rippling order; "up" makes them flare brighter as it passes.
  const WAVE_SPREAD = 0.7; // seconds for the wave to reach the far edge
  // Each building's delay grows with its distance from originX, so lights switching on or off (and
  // the wave animations) ripple outward from there.
  function rippleFrom(originX) {
    const reach = Math.max(originX, W - originX) || 1;
    for (const building of buildings) {
      const distance = Math.abs(building.x + building.w / 2 - originX) / reach;
      building.el.style.setProperty("--wave-delay", `${(distance * WAVE_SPREAD).toFixed(3)}s`);
    }
  }
  function wave(direction, originX = W / 2) {
    if (reducedMotion() || !buildings.length) return;
    rippleFrom(originX);
    root.classList.remove("wave-down", "wave-up");
    void root.offsetWidth; // restart the animation if a wave is already running
    root.classList.add(`wave-${direction}`);
    clearTimeout(waveTimer);
    waveTimer = setTimeout(() => root.classList.remove(`wave-${direction}`), (WAVE_SPREAD + 1) * 1000);
  }

  // Lightning, fireworks and anything passing over the city go on the same layer as the city, so
  // when the view rises after the battery runs out they move with the city instead of floating
  // over it.
  const scene = () => root.querySelector(".city-world") || root;

  // A jagged line between two points: the midpoint of every segment is pushed sideways a little,
  // again and again, which gives lightning its natural crooked shape.
  function jagged(x1, y1, x2, y2, roughness) {
    let points = [[x1, y1], [x2, y2]];
    for (let pass = 0; pass < 6; pass++) {
      const next = [points[0]];
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1], [bx, by] = points[i];
        const length = Math.hypot(bx - ax, by - ay);
        const push = (Math.random() - 0.5) * length * roughness;
        next.push([(ax + bx) / 2 + push * (ay - by) / (length || 1), (ay + by) / 2 + push * (bx - ax) / (length || 1)], points[i]);
      }
      points = next;
    }
    return points;
  }

  // Branches split off the main bolt (and, for a perfect answer, off the branches too).
  function branches(points, count, reach, depth, out) {
    for (let b = 0; b < count; b++) {
      const at = Math.floor(points.length * (0.15 + Math.random() * 0.6));
      const [x, y] = points[at];
      const side = Math.random() < 0.5 ? -1 : 1;
      const angle = (20 + Math.random() * 45) * (Math.PI / 180);
      const length = reach * (0.5 + Math.random() * 0.5);
      const branch = jagged(x, y, x + side * Math.sin(angle) * length, y + Math.cos(angle) * length, 0.35);
      out.push({ points: branch, depth });
      if (depth < 2 && out.length < 40) branches(branch, depth === 1 ? 2 : 0, length * 0.55, depth + 1, out);
    }
    return out;
  }

  // Lightning striking the city: a bolt from the sky down onto a rooftop, a flash across the sky,
  // a burst of light where it lands, and the struck building lit up for a moment. A perfect answer
  // (exact to the tenth) gets a bigger, wider, more branched bolt, a double flicker and sparks.
  function strike({ perfect = false, outage = false } = {}) {
    if (!buildings.length) return null;
    const phone = W < 600;
    // Lightning finds tall things: pick among the taller front buildings, away from the screen edges.
    const candidates = buildings.filter(b => b.row > 0 && b.x + b.w / 2 > W * 0.12 && b.x + b.w / 2 < W * 0.88)
      .sort((a, b) => a.top - b.top).slice(0, 6);
    const target = candidates[Math.floor(Math.random() * candidates.length)] || buildings[0];
    const hitX = target.x + target.w / 2;
    const hitY = target.top;
    const startX = Math.min(W * 0.95, Math.max(W * 0.05, hitX + (Math.random() - 0.5) * W * (perfect ? 0.5 : 0.35)));
    const main = jagged(startX, -10, hitX, hitY, 0.22);
    const reach = H * (perfect ? 0.32 : 0.16) * (phone ? 1 : 0.8);
    const forks = branches(main, perfect ? 7 : 3, reach, perfect ? 1 : 2, []);
    const path = points => points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    const width = { core: perfect ? 3.5 : 2.5, glow: perfect ? 18 : 11 };
    const forkLines = forks.map(({ points, depth }) => {
      const scale = depth === 1 ? 0.55 : 0.35;
      return `<path class="bolt-glow" d="${path(points)}" stroke-width="${(width.glow * scale).toFixed(1)}"/><path class="bolt-core" d="${path(points)}" stroke-width="${(width.core * scale).toFixed(1)}" opacity="${depth === 1 ? 0.85 : 0.6}"/>`;
    }).join("");
    let sparks = "";
    if (perfect) {
      for (let i = 0; i < 18; i++) {
        const angle = Math.PI + Math.random() * Math.PI; // up and out from the roof
        const distance = 30 + Math.random() * (phone ? 60 : 110);
        sparks += `<rect class="spark" x="${(hitX - P / 2).toFixed(0)}" y="${(hitY - P / 2).toFixed(0)}" width="${P}" height="${P}" style="--dx:${(Math.cos(angle) * distance).toFixed(0)}px;--dy:${(Math.sin(angle) * distance).toFixed(0)}px;animation-delay:${(Math.random() * 0.12).toFixed(2)}s"/>`;
      }
    }
    scene().insertAdjacentHTML("beforeend", `<svg class="city-bolt${perfect ? " perfect" : ""}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">
        <defs><radialGradient id="impact"><stop offset="0" stop-color="#fffaf0" stop-opacity=".9"/><stop offset=".4" stop-color="var(--bolt-glow, #ffd56a)" stop-opacity=".45"/><stop offset="1" stop-color="var(--bolt-glow, #ffd56a)" stop-opacity="0"/></radialGradient></defs>
        <circle class="impact" cx="${hitX.toFixed(0)}" cy="${hitY.toFixed(0)}" r="${perfect ? 90 : 50}" fill="url(#impact)"/>
        ${forkLines}
        <path class="bolt-glow" d="${path(main)}" stroke-width="${width.glow}"/><path class="bolt-core" d="${path(main)}" stroke-width="${width.core}"/>
        ${sparks}
      </svg><div class="city-flash${perfect ? " perfect" : ""}" style="--x:${((hitX / W) * 100).toFixed(1)}%"></div>`);
    const flash = scene().lastElementChild;
    const bolt = flash.previousElementSibling;
    // The struck building lights up, even if the battery had already switched it off, and a wave of
    // light runs out through the city from it. A strike that knocks the power out (outage) does
    // neither: the lights go out from it instead (see outOfCharge).
    if (!outage) {
      target.el.classList.add("hit");
      wave("up", hitX);
    }
    const duration = reducedMotion() ? 600 : perfect ? 1500 : 1000;
    setTimeout(() => {
      bolt?.remove();
      flash?.remove();
      target.el.classList.remove("hit");
    }, duration);
    return hitX;
  }

  // The guess that runs the battery out has just been revealed. The city keeps its lights on while
  // the battery drains and the game fades away; then (lightsOutAfter) the lights go out in a ripple
  // from the middle, the buildings turn black against the sky, and once the dark city has been
  // seen the view rises slowly up into the night above it. onTop runs once the view is at the top.
  // An endless run that runs out in daylight gets a storm instead: the storm rolls in over the city,
  // lightning strikes a building and the lights go out from there, and the view rises into the
  // storm clouds.
  const SILHOUETTE_MS = 800; // after the lights go out
  const RISE_AFTER_MS = 1600; // after the lights go out
  const STORM_STRIKE_MS = 1800; // from the storm rolling in to the lightning
  const RISE_MS = 6000; // keep in step with .city-world's transition in percentle.css
  function outOfCharge(onTop, lightsOutAfter = 0) {
    rising = true;
    const still = reducedMotion();
    heldLevel = still ? null : level > 0 ? level : heldLevel ?? 1;
    const later = (ms, step) => setTimeout(() => { if (rising) step(); }, still ? 0 : ms);
    const stormy = hour !== null && skyAt(hour).day >= STORM_DAYLIGHT;
    if (stormy) {
      later(lightsOutAfter, () => { storming = true; refresh(); });
      lightsOutAfter += still ? 0 : STORM_STRIKE_MS;
    }
    later(lightsOutAfter, () => {
      const hitX = stormy && !still ? strike({ outage: true }) : null;
      rippleFrom(hitX ?? W / 2);
      heldLevel = null;
      refresh();
    });
    later(lightsOutAfter + SILHOUETTE_MS, () => root.classList.add("blackout"));
    later(lightsOutAfter + RISE_AFTER_MS, () => {
      root.classList.add("skyward");
      setTimeout(() => { if (rising) onTop?.(); }, still ? 600 : RISE_MS + 150);
    });
  }

  // A pixel flying saucer that zips across the top of the screen at height y (screen pixels), once
  // the out-of-charge screen is up: a glass dome, a gray hull with blinking rim lights and a green
  // glow underneath. It's its own layer sliding at a steady speed, so it glides smoothly.
  function ufo(y) {
    if (reducedMotion() || storming || root.querySelector(".city-ufo")) return;
    const u = W < 600 ? 2 : 3;
    const r = ([x, yy, w, h]) => `<rect x="${x * u}" y="${yy * u}" width="${w * u}" height="${h * u}"/>`;
    root.insertAdjacentHTML("beforeend", `<div class="city-ufo" style="top:${Math.round(y)}px;--travel:${W + 16 * u + 40}px"><div class="ufo-bob">
        <svg width="${16 * u}" height="${8 * u}" viewBox="0 0 ${16 * u} ${8 * u}">
          <g class="ufo-glow">${[[5, 6, 6, 1], [6, 7, 4, 1]].map(r).join("")}</g>
          <g class="ufo-dome">${[[6, 0, 4, 1], [5, 1, 6, 2]].map(r).join("")}</g>
          <g class="ufo-hull">${[[2, 3, 12, 1], [0, 4, 16, 1], [2, 5, 12, 1]].map(r).join("")}</g>
          ${[2, 6, 10, 14].map((x, k) => `<rect class="ufo-light ufo-light-${k % 2}" x="${x * u}" y="${4 * u}" width="${u}" height="${u}"/>`).join("")}
        </svg></div></div>`);
    const el = root.lastElementChild;
    el.addEventListener("animationend", event => { if (event.target === el) el.remove(); });
  }

  // A small, distant plane drifting across the sky at height y (in screen pixels): a dark side-on
  // pixel silhouette with a row of lit cabin windows, a blinking red light under the wing and a white
  // strobe on the tail.
  function plane(y) {
    if (rising || reducedMotion() || root.querySelector(".city-plane")) return;
    const s = W < 600 ? 2.5 : 3; // pixel size
    const r = ([x, yy, w, h]) => `<rect x="${x * s}" y="${yy * s}" width="${w * s}" height="${h * s}"/>`;
    // Fuselage, rounded nose, tail fin, and a swept wing below the middle.
    const body = [[1, 3, 14, 2], [15, 4, 1, 1], [14, 3, 1, 1], [1, 0, 1, 3], [2, 1, 1, 2], [3, 2, 1, 1], [6, 5, 4, 1], [5, 6, 3, 1]].map(r).join("");
    const windows = [5, 7, 9, 11, 13].map(x => `<rect x="${x * s}" y="${3 * s}" width="${s}" height="${s}"/>`).join("");
    const leftToRight = Math.random() < 0.5;
    const width = 16 * s;
    scene().insertAdjacentHTML("beforeend", `<div class="city-plane${leftToRight ? "" : " flip"}" style="top:${Math.round(y)}px;--travel:${W + width * 2 + 40}px;animation-duration:${(18 + Math.random() * 7).toFixed(1)}s">
        <svg width="${width}" height="${8 * s}" viewBox="0 0 ${width} ${7 * s}"><g class="plane-body">${body}</g><g class="plane-windows">${windows}</g>
          <rect class="plane-red" x="${5 * s}" y="${6 * s}" width="${s}" height="${s}"/>
          <rect class="plane-strobe" x="${1 * s}" y="0" width="${s}" height="${s}"/></svg></div>`);
    const el = scene().lastElementChild;
    el.addEventListener("animationend", event => { if (event.target === el) el.remove(); });
  }

  // Pixel fireworks: bursts at spots given as fractions of the screen, each a little after the last.
  function launch(spots, { repeat = 2, gap = 0.55 } = {}) {
    if (reducedMotion() || !buildings.length) return;
    const step = W < 600 ? 5.5 : 11;
    let bursts = "";
    spots.forEach(([fx, fy], k) => {
      const cx = W * fx, cy = H * fy;
      let dots = "";
      for (let a = 0; a < 16; a++) {
        const angle = (a / 16) * Math.PI * 2;
        for (let s = 1; s <= 5; s++) {
          dots += `<rect x="${(cx + Math.cos(angle) * s * step).toFixed(0)}" y="${(cy + Math.sin(angle) * s * step).toFixed(0)}" width="${P}" height="${P}" fill-opacity="${(1 - s * 0.16).toFixed(2)}"/>`;
        }
      }
      bursts += `<g class="burst burst-${k % 3}" style="animation-delay:${(k * gap).toFixed(2)}s;animation-iteration-count:${repeat}">${dots}<rect class="burst-core" x="${(cx - P).toFixed(0)}" y="${(cy - P).toFixed(0)}" width="${P * 2}" height="${P * 2}"/></g>`;
    });
    scene().insertAdjacentHTML("beforeend", `<svg class="city-fireworks" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">${bursts}</svg>`);
    const svg = scene().lastElementChild;
    setTimeout(() => svg?.remove(), (1.8 * repeat + spots.length * gap) * 1000 + 300);
  }

  // Three fireworks in the open sky beside the final battery, for a strong finish.
  function fireworks() {
    launch(W < 600 ? [[0.1, 0.37], [0.9, 0.31], [0.88, 0.47]] : [[0.18, 0.22], [0.82, 0.16], [0.86, 0.4]]);
  }

  // One small firework in open sky to one side, for a very close guess.
  function firework() {
    const left = Math.random() < 0.5;
    const phone = W < 600;
    const fx = phone ? (left ? 0.1 : 0.9) : left ? 0.08 + Math.random() * 0.1 : 0.82 + Math.random() * 0.1;
    launch([[fx, phone ? 0.3 + Math.random() * 0.12 : 0.18 + Math.random() * 0.2]], { repeat: 1 });
  }

  // Whether a passing animation can play now: not on the start screen, not while the battery has
  // run out, not in a background tab, and never for anyone who prefers less motion.
  function lively() {
    const body = document.body;
    return !rising && !reducedMotion() && !document.hidden && buildings.length > 0 &&
      !body.classList.contains("starting") && !body.classList.contains("dead") && !root.classList.contains("out");
  }

  // Screen position (from the top of the window) of a height in the scene, which is pinned to the
  // bottom of the screen.
  const toScreen = y => y + (window.innerHeight - H);
  // The top of the skyline: a typical tall roof (the 15th percentile), so a single spire doesn't count.
  const skylineScreenTop = () => {
    const tops = buildings.map(b => b.top).sort((x, y) => x - y);
    return toScreen(tops[Math.floor(tops.length * 0.15)] ?? H * 0.75);
  };

  // Something drifting across the screen at height y (screen pixels) and then removed. kind is a
  // class for its look; html is its drawing; seconds is how long the crossing takes.
  function drift(kind, html, y, width, seconds, leftToRight = Math.random() < 0.5) {
    scene().insertAdjacentHTML("beforeend", `<div class="city-drift ${kind}${leftToRight ? "" : " flip"}" style="top:${Math.round(y)}px;--travel:${W + width * 2 + 40}px;animation-duration:${seconds}s">${html}</div>`);
    const el = scene().lastElementChild;
    el.addEventListener("animationend", event => { if (event.target === el) el.remove(); });
    return el;
  }

  // A shooting star: a quick streak of light with a fading tail, high in the sky.
  function shootingStar(y) {
    if (!lively()) return;
    const x = W * (0.1 + Math.random() * 0.6), length = W < 600 ? 110 : 190, angle = (12 + Math.random() * 18) * Math.PI / 180;
    const x2 = x + Math.cos(angle) * length, y2 = y + Math.sin(angle) * length;
    scene().insertAdjacentHTML("beforeend", `<svg class="city-meteor" width="${W}" height="${window.innerHeight}">
        <defs><linearGradient id="meteorTail" gradientUnits="userSpaceOnUse" x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${x2.toFixed(0)}" y2="${y2.toFixed(0)}"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".95"/></linearGradient></defs>
        <line x1="${x.toFixed(0)}" y1="${y.toFixed(0)}" x2="${x2.toFixed(0)}" y2="${y2.toFixed(0)}" stroke="url(#meteorTail)" stroke-width="2.5" stroke-linecap="round" pathLength="100"/></svg>`);
    const svg = scene().lastElementChild;
    setTimeout(() => svg.remove(), 1400);
  }

  // A blimp drifting slowly just above the rooftops, with a lit banner along its side.
  function blimp() {
    if (!lively() || root.querySelector(".blimp")) return;
    const s = W < 600 ? 2 : 3;
    let body = "";
    for (let row = -5; row <= 5; row++) {
      const half = Math.round(Math.sqrt(1 - (row / 6) ** 2) * 26);
      body += `<rect x="${(30 - half) * s}" y="${(row + 7) * s}" width="${half * 2 * s}" height="${s}"/>`;
    }
    body += `<rect x="${54 * s}" y="${1 * s}" width="${4 * s}" height="${4 * s}"/><rect x="${54 * s}" y="${9 * s}" width="${4 * s}" height="${4 * s}"/><rect x="${24 * s}" y="${13 * s}" width="${12 * s}" height="${3 * s}"/>`;
    const html = `<svg width="${60 * s}" height="${17 * s}" viewBox="0 0 ${60 * s} ${17 * s}"><g class="blimp-body">${body}</g>
        <rect class="blimp-banner" x="${12 * s}" y="${5 * s}" width="${36 * s}" height="${5 * s}"/>
        <text class="blimp-text" x="${30 * s}" y="${8.8 * s}" font-size="${3.4 * s}">CHARGLE.IO</text>
        <rect class="plane-red" x="${29 * s}" y="${16 * s}" width="${s}" height="${s}"/></svg>`;
    drift("blimp", html, skylineScreenTop() - (W < 600 ? 0 : 17 * s + 24), 60 * s, 48 + Math.random() * 10);
  }

  // A helicopter that flies in, hovers above the rooftops sweeping a searchlight over them, and
  // flies off. Mostly late at night.
  function helicopter() {
    if (!lively() || root.querySelector(".heli")) return;
    const s = W < 600 ? 2 : 3;
    const gutter = (W - 720) / 2;
    const hoverX = W < 600 ? W * 0.8 : gutter > 160 ? W - gutter / 2 : W * 0.88;
    // On a phone the guess bar covers the sky just above the roofs, so it flies lower, over them.
    const y = skylineScreenTop() - (W < 600 ? -8 : 110);
    const rect = (x, yy, w, h, cls = "") => `<rect${cls ? ` class="${cls}"` : ""} x="${x * s}" y="${yy * s}" width="${w * s}" height="${h * s}"/>`;
    const html = `<div class="heli-body"><svg width="${30 * s}" height="${12 * s}" viewBox="0 0 ${30 * s} ${12 * s}">
        <g class="heli-rotor">${rect(2, 0, 22, 1)}</g>
        <g class="heli-shape">${rect(12, 1, 1, 2)}${rect(7, 3, 11, 5)}${rect(18, 4, 9, 2)}${rect(26, 2, 2, 4)}${rect(8, 9, 10, 1)}${rect(10, 8, 1, 1)}${rect(15, 8, 1, 1)}</g>
        ${rect(8, 4, 3, 2, "heli-window")}${rect(27, 2, 1, 1, "plane-red")}</svg>
        <svg class="heli-beam" width="${120 * s}" height="${70 * s}" viewBox="0 0 ${120 * s} ${70 * s}"><defs><linearGradient id="heliBeam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6d8" stop-opacity=".55"/><stop offset="1" stop-color="#fff6d8" stop-opacity="0"/></linearGradient></defs>
        <polygon points="${58 * s},0 ${62 * s},0 ${80 * s},${70 * s} ${40 * s},${70 * s}" fill="url(#heliBeam)"/></svg></div>`;
    scene().insertAdjacentHTML("beforeend", `<div class="heli" style="top:${Math.round(y)}px;left:${Math.round(hoverX - 15 * s)}px;--away:${Math.round(W - hoverX + 60 * s)}px">${html}</div>`);
    const el = scene().lastElementChild;
    el.addEventListener("animationend", event => { if (event.target === el) el.remove(); });
  }

  // A small V of birds crossing the sky, wings flapping (dawn and dusk in endless).
  function birds(y) {
    if (!lively() || root.querySelector(".birds")) return;
    const s = W < 600 ? 2 : 3;
    const flock = [[12, 0], [8, 3], [16, 3], [4, 6], [20, 6], [0, 9]];
    const one = ([x, yy], k) => `<g class="bird" transform="translate(${x * s} ${yy * s})" style="animation-delay:-${(k * 0.13).toFixed(2)}s">
        <g class="wing-up"><rect x="0" y="0" width="${s}" height="${s}"/><rect x="${s}" y="${s}" width="${s}" height="${s}"/><rect x="${2 * s}" y="0" width="${s}" height="${s}"/></g>
        <g class="wing-down"><rect x="0" y="${s}" width="${s}" height="${s}"/><rect x="${s}" y="0" width="${s}" height="${s}"/><rect x="${2 * s}" y="${s}" width="${s}" height="${s}"/></g></g>`;
    drift("birds", `<svg width="${24 * s}" height="${12 * s}" viewBox="0 0 ${24 * s} ${12 * s}">${flock.map(one).join("")}</svg>`, y, 24 * s, 16 + Math.random() * 6);
  }

  // Searchlights sweeping across the sky from behind the skyline, for a perfect game.
  function searchlights() {
    if (reducedMotion() || !buildings.length || root.querySelector(".city-searchlights")) return;
    const spots = W < 600 ? [0.12, 0.88] : [0.1, 0.2, 0.8, 0.9];
    const beams = spots.map((f, k) => `<div class="searchlight" style="left:${(W * f).toFixed(0)}px;animation-delay:-${(k * 1.3).toFixed(1)}s;--swing:${k % 2 ? -1 : 1}"></div>`).join("");
    scene().insertAdjacentHTML("beforeend", `<div class="city-searchlights">${beams}</div>`);
    const el = scene().lastElementChild;
    setTimeout(() => el.classList.add("fading"), 14000);
    setTimeout(() => el.remove(), 15500);
  }

  // Windows flicking on and off: every few seconds someone somewhere turns a light on, or off.
  function flickWindow() {
    if (lively()) {
      const lit = buildings.filter(b => b.el.classList.contains("on"));
      const building = lit[Math.floor(Math.random() * lit.length)];
      if (building) {
        const dark = [...building.el.querySelectorAll("rect.dark")];
        const glowing = [...building.el.querySelectorAll("rect:not(.dark)")];
        const turnOn = dark.length && (Math.random() < 0.5 || glowing.length < 3);
        const pick = list => list[Math.floor(Math.random() * list.length)];
        if (turnOn) pick(dark).classList.remove("dark");
        else if (glowing.length) pick(glowing).classList.add("dark");
      }
    }
    setTimeout(flickWindow, 2000 + Math.random() * 4000);
  }
  setTimeout(flickWindow, 3000);

  // New Year's and the Fourth of July: a firework over the city every several seconds.
  function holidayFireworks() {
    if ((holiday === "newyear" || holiday === "july4") && lively()) {
      const left = Math.random() < 0.5;
      const phone = W < 600;
      launch([[phone ? (left ? 0.12 : 0.88) : left ? 0.05 + Math.random() * 0.17 : 0.78 + Math.random() * 0.17, (phone ? 0.25 : 0.12) + Math.random() * 0.25]], { repeat: 1 });
    }
    setTimeout(holidayFireworks, 5000 + Math.random() * 5000);
  }
  setTimeout(holidayFireworks, 4000);

  // The billboard's two lines (empty lines are fine).
  // Puts the billboard on the tallest roof where nothing in the game covers it (the rectangles in
  // billboardAvoid, in screen pixels), preferring the right half. If every roof is covered, it hides.
  let billboardAvoid = [];
  function placeBillboard() {
    const el = root.querySelector(".billboard");
    if (!el || !billboard) return;
    const spots = billboard.roofs.map(roof => ({ roof, x: Math.round(roof.x + roof.w / 2 - billboard.w / 2), y: Math.round(roof.top - billboard.h - P * 3) }));
    const clear = spot => billboardAvoid.every(r => {
      const top = toScreen(spot.y), bottom = top + billboard.h + P * 3;
      return spot.x + billboard.w < r.left - 4 || spot.x > r.right + 4 || bottom < r.top - 4 || top > r.bottom + 4;
    });
    // The tallest clear roof on the right half first, then anywhere.
    let spot = spots.find(s => s.x + billboard.w / 2 > W * 0.45 && clear(s)) || spots.find(clear);
    // Small screens may have no clear roof (the sky above the roofs is under the game). Then it hangs
    // flat on the front of a building instead, just below the game, preferring the right half.
    let onWall = false;
    if (!spot) {
      const below = Math.max(0, ...billboardAvoid.map(r => r.bottom)) - (window.innerHeight - H) + P;
      const walls = billboard.walls.map(roof => ({ roof, x: Math.round(roof.x + roof.w / 2 - billboard.w / 2), y: Math.round(Math.max(below, roof.top + P * 2)) }))
        .filter(w => w.y + billboard.h <= H - P && clear(w));
      spot = walls.find(w => w.x + billboard.w / 2 > W * 0.45) || walls[0];
      onWall = Boolean(spot);
    }
    if (!spot) { el.style.display = "none"; return; }
    el.style.display = "";
    el.setAttribute("transform", `translate(${spot.x} ${spot.y})`);
    // On a roof it stands on two braced posts under the board, both on the roof, with its light
    // spilling onto the roof; on a wall it needs none.
    el.querySelector(".bb-legs").style.display = onWall ? "none" : "";
    const left = Math.max(P * 3, spot.roof.x - spot.x + P), right = Math.min(billboard.w - P * 4, spot.roof.x + spot.roof.w - spot.x - P * 2);
    el.querySelector(".bb-post-l").setAttribute("x", left);
    el.querySelector(".bb-post-r").setAttribute("x", right);
    el.querySelector(".bb-brace").setAttribute("x", left);
    el.querySelector(".bb-brace").setAttribute("width", right - left + P);
    el.querySelector(".bb-spill").setAttribute("x", Math.max(0, spot.roof.x - spot.x));
    el.querySelector(".bb-spill").setAttribute("width", Math.min(billboard.w, spot.roof.x + spot.roof.w - spot.x) - Math.max(0, spot.roof.x - spot.x));
  }

  function showBillboard() {
    const one = root.querySelector(".bb-1"), two = root.querySelector(".bb-2");
    if (one) one.textContent = billboardText[0] || "";
    if (two) two.textContent = billboardText[1] || "";
  }

  build();
  // Hard mode, the start screen and the out-of-charge screen are all body classes.
  new MutationObserver(refresh).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (window.innerWidth !== builtWidth) build(); }, 200);
  });

  return {
    setLevel(charge) {
      if (charge === level) return;
      level = charge;
      refresh();
    },
    setTime(next) {
      if (next === hour) return;
      hour = next;
      refresh();
    },
    // What the sky is doing now: how light it is (0 night to 1 day) and the endless clock's hour
    // (null in the daily puzzle).
    state() {
      return { daylight: skyAt(hour ?? 0).day, hour };
    },
    setWeather(kind) {
      weatherKind = kind || null;
      refresh();
    },
    setHoliday(name) {
      holiday = name || null;
      refresh();
    },
    setSnow(levelNow, falling = false) {
      snowLevel = Math.max(0, Math.min(1, levelNow));
      snowFalling = falling;
      refresh();
    },
    setBillboard(lines) {
      billboardText = lines;
      showBillboard();
    },
    // Parts of the game the billboard should stay clear of (screen rectangles).
    avoidForBillboard(rects) {
      billboardAvoid = rects;
      placeBillboard();
    },
    wave,
    plane,
    shootingStar,
    blimp,
    helicopter,
    birds,
    outOfCharge,
    ufo,
    strike,
    fireworks,
    firework,
    searchlights
  };
}
