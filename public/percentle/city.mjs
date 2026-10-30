// The pixel-art city behind the game. It runs on the player's battery: every building has its own
// charge cut-off, so blocks of the city go dark one after another as the charge drains, and the
// stars come out as its glow fades. Supercharges strike it with lightning, a strong finish sets off
// fireworks, hard mode turns the night into a purple storm, and in endless mode the clock moves on
// each round (night, dawn, day, dusk, night again).
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
      stars += `<rect x="${px(r() * W)}" y="${px(r() * H * 0.62)}" width="${size}" height="${size}" opacity="${(0.25 + r() * 0.75).toFixed(2)}"/>`;
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
            windows += `<rect class="${kind}" x="${x + P + c * P * 3}" y="${wy}" width="${P}" height="${P * 1.5}" opacity="${(layer.win * dim * (0.55 + lr() * 0.45)).toFixed(2)}"/>`;
          }
        }
        lights += `<g class="bw" data-cutoff="${cutoff}">${windows}</g>`;
        placed.push({ x, w: bw, top: by, row: n });
        x += bw + (lr() < 0.3 ? P * 2 : 0);
      }
      layout.push(...placed);
      city += `<g class="row row-${n}">${shapes}</g><g class="lights">${lights}</g><g class="beacons">${beacons}</g>`;
    });

    root.innerHTML = `<div class="city-glow"></div>
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
      <div class="city-scan"></div>`;
    buildings = [...root.querySelectorAll(".bw")].map((el, i) => ({ el, cutoff: Number(el.dataset.cutoff), ...layout[i] }));
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
    const shown = body.classList.contains("starting") ? 0 : Math.max(0, Math.min(100, level));
    const out = shown <= 0;
    for (const building of buildings) building.el.classList.toggle("on", building.cutoff < shown);
    root.classList.toggle("out", out);
    root.classList.toggle("low", shown > 0 && shown < 20);

    const sky = skyAt(hour ?? 0);
    const night = 1 - sky.day;
    let top = sky.top, bottom = sky.bottom;
    if (hard) {
      top = mix(top, "#0d0418", 0.6);
      bottom = mix(bottom, "#3a1a5c", 0.55);
    }
    if (out) {
      top = mix(top, "#000000", 0.4 * night);
      bottom = mix(bottom, "#000000", 0.5 * night);
    }
    const rows = hard ? BUILDINGS_HARD : BUILDINGS_NIGHT;
    const style = root.style;
    style.setProperty("--sky-top", top);
    style.setProperty("--sky-bottom", bottom);
    rows.forEach((color, i) => style.setProperty(`--row-${i}`, mix(color, BUILDINGS_DAY[i], hard ? sky.day * 0.5 : sky.day)));
    style.setProperty("--stars", (night * (0.25 + (1 - shown / 100) * 0.75)).toFixed(3));
    style.setProperty("--windows", (1 - sky.day * 0.7).toFixed(3));
    style.setProperty("--glow", out ? "0" : (night * (0.25 + (shown / 100) * 0.75)).toFixed(3));
    style.setProperty("--daylight", sky.day.toFixed(3));

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
    lastSpot.set(el, to);
    const at = p => `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
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
  // pressing Endless glides it across the sky from the daily spot. From 6 PM it rises to that spot;
  // through the night it drifts across the sky, a little higher around midnight, and sets on the
  // far side by dawn. In daylight it waits below the horizon on the left, where it rises again.
  function moonSpot(h) {
    const phone = W < 600;
    const nine = { x: W * (phone ? 0.075 : 0.16), y: H * (phone ? 0.125 : 0.12) };
    const rise = { x: W * 0.02, y: H * 0.34 };
    const since = (h - 18 + 24) % 24; // hours since 6 PM
    if (since > 12) return { x: rise.x, y: H * 0.62 };
    if (since <= 3) {
      const t = 1 - (1 - since / 3) ** 2;
      return { x: rise.x + (nine.x - rise.x) * t, y: rise.y + (nine.y - rise.y) * t };
    }
    const t = (since - 3) / 9; // 9 PM to 6 AM
    return { x: nine.x + (W * 0.95 - nine.x) * t, y: nine.y - H * 0.05 * Math.sin(Math.PI * t) + (H * 0.36 - nine.y) * t * t };
  }

  // Where the sun is at an hour: rising on the left at 6 AM, highest at noon, setting on the right
  // at 6 PM. At night it waits below the horizon on the left, where it rises next.
  function sunSpot(h) {
    const t = (h - 6) / 12;
    if (t < 0 || t > 1) return { x: W * 0.08, y: H * 0.62 };
    return { x: W * (0.08 + 0.84 * t), y: H * (0.3 - 0.25 * Math.sin(Math.PI * t)) };
  }

  // A wave through the windows, rippling out from a point on the skyline (the middle by default).
  // "down" dims every lit window as it passes, and the buildings losing power go dark in the same
  // rippling order; "up" makes them flare brighter as it passes.
  const WAVE_SPREAD = 0.7; // seconds for the wave to reach the far edge
  function wave(direction, originX = W / 2) {
    if (reducedMotion() || !buildings.length) return;
    const reach = Math.max(originX, W - originX) || 1;
    for (const building of buildings) {
      const distance = Math.abs(building.x + building.w / 2 - originX) / reach;
      building.el.style.setProperty("--wave-delay", `${(distance * WAVE_SPREAD).toFixed(3)}s`);
    }
    root.classList.remove("wave-down", "wave-up");
    void root.offsetWidth; // restart the animation if a wave is already running
    root.classList.add(`wave-${direction}`);
    clearTimeout(waveTimer);
    waveTimer = setTimeout(() => root.classList.remove(`wave-${direction}`), (WAVE_SPREAD + 1) * 1000);
  }

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
  function strike({ perfect = false } = {}) {
    if (!buildings.length) return;
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
    root.insertAdjacentHTML("beforeend", `<svg class="city-bolt${perfect ? " perfect" : ""}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">
        <defs><radialGradient id="impact"><stop offset="0" stop-color="#fffaf0" stop-opacity=".9"/><stop offset=".4" stop-color="var(--bolt-glow, #ffd56a)" stop-opacity=".45"/><stop offset="1" stop-color="var(--bolt-glow, #ffd56a)" stop-opacity="0"/></radialGradient></defs>
        <circle class="impact" cx="${hitX.toFixed(0)}" cy="${hitY.toFixed(0)}" r="${perfect ? 90 : 50}" fill="url(#impact)"/>
        ${forkLines}
        <path class="bolt-glow" d="${path(main)}" stroke-width="${width.glow}"/><path class="bolt-core" d="${path(main)}" stroke-width="${width.core}"/>
        ${sparks}
      </svg><div class="city-flash${perfect ? " perfect" : ""}" style="--x:${((hitX / W) * 100).toFixed(1)}%"></div>`);
    const flash = root.lastElementChild;
    const bolt = flash.previousElementSibling;
    // The struck building lights up, even if the battery had already switched it off, and a wave of
    // light runs out through the city from it.
    target.el.classList.add("hit");
    wave("up", hitX);
    const duration = reducedMotion() ? 600 : perfect ? 1500 : 1000;
    setTimeout(() => {
      bolt?.remove();
      flash?.remove();
      target.el.classList.remove("hit");
    }, duration);
  }

  // Pixel fireworks in the open sky beside the final battery.
  function fireworks() {
    if (reducedMotion() || !buildings.length) return;
    const phone = W < 600;
    const spots = phone ? [[0.1, 0.37], [0.9, 0.31], [0.88, 0.47]] : [[0.18, 0.22], [0.82, 0.16], [0.86, 0.4]];
    const step = phone ? 5.5 : 11;
    let bursts = "";
    spots.forEach(([fx, fy], k) => {
      const cx = W * fx, cy = H * fy;
      let dots = "";
      for (let a = 0; a < 16; a++) {
        const angle = (a / 16) * Math.PI * 2;
        for (let s = 1; s <= 5; s++) {
          dots += `<rect x="${(cx + Math.cos(angle) * s * step).toFixed(0)}" y="${(cy + Math.sin(angle) * s * step).toFixed(0)}" width="${P}" height="${P}" opacity="${(1 - s * 0.16).toFixed(2)}"/>`;
        }
      }
      bursts += `<g class="burst burst-${k}" style="animation-delay:${k * 0.55}s">${dots}<rect class="burst-core" x="${(cx - P).toFixed(0)}" y="${(cy - P).toFixed(0)}" width="${P * 2}" height="${P * 2}"/></g>`;
    });
    root.insertAdjacentHTML("beforeend", `<svg class="city-fireworks" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">${bursts}</svg>`);
    const svg = root.lastElementChild;
    setTimeout(() => svg?.remove(), 5200);
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
    wave,
    strike,
    fireworks
  };
}
