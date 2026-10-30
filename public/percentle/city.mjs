// The pixel-art city behind the game. It runs on the player's battery: every building has its own
// charge cut-off, so blocks of the city go dark one after another as the charge drains, and the
// stars come out as its glow fades. Supercharges strike it with lightning, a strong finish sets off
// fireworks, hard mode turns the night into a purple storm, and in endless mode the clock moves on
// each round (night, dawn, day, dusk, night again).
//
// A power line runs from the player's battery down into a rooftop, with current flowing along it:
// bright and fast when charged, slower and dimmer as the battery drains, dark when it's empty.
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

export function createCity(root) {
  let level = 100;
  let hour = null; // null: the daily puzzle's fixed late night
  let buildings = [];
  let builtWidth = 0;
  let W = 0;
  let H = 0;
  let P = 3;
  let cableSource = null; // returns the battery element the power line plugs into
  let cableFrame = 0;

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
    // A pixel crescent moon and a pixel sun, drawn around (0, 0) and moved into place later.
    const moonR = phone ? 12 : 22;
    let moon = "";
    for (let y = -moonR; y <= moonR; y += P) for (let x = -moonR; x <= moonR; x += P) {
      if (x * x + y * y <= moonR * moonR && (x + moonR * 0.45) ** 2 + (y - moonR * 0.1) ** 2 > (moonR * 0.85) ** 2) {
        moon += `<rect x="${x}" y="${y}" width="${P}" height="${P}"/>`;
      }
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
      <svg class="city-cable" aria-hidden="true"><path class="cable-wire"/><path class="cable-glow"/><path class="cable-flow"/></svg>
      <div class="city-scan"></div>`;
    buildings = [...root.querySelectorAll(".bw")].map((el, i) => ({ el, cutoff: Number(el.dataset.cutoff), ...layout[i] }));
    refresh();
    placeCable();
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
    style.setProperty("--flow", out ? "0" : (0.35 + (shown / 100) * 0.65).toFixed(3));
    style.setProperty("--flow-time", `${(2.6 - (shown / 100) * 2).toFixed(2)}s`);

    // The moon and sun cross the sky. The daily puzzle's moon sits still in a fixed spot.
    const moon = root.querySelector(".moon");
    const sun = root.querySelector(".sun");
    if (!moon || !sun) return;
    if (hour === null) {
      const phone = W < 600;
      moon.setAttribute("transform", `translate(${phone ? W * 0.075 : W * 0.84} ${phone ? H * 0.125 : H * 0.12})`);
      sun.setAttribute("transform", `translate(${W / 2} ${H * 2})`);
    } else {
      const h = ((hour % 24) + 24) % 24;
      const arc = (progress, low, high) => `translate(${(W * (0.08 + 0.84 * progress)).toFixed(1)} ${(H * (low - (low - high) * Math.sin(Math.PI * progress))).toFixed(1)})`;
      const nightProgress = ((h - 18 + 24) % 24) / 12; // 6 PM to 6 AM
      const dayProgress = (h - 6) / 12; // 6 AM to 6 PM
      moon.setAttribute("transform", nightProgress <= 1 ? arc(nightProgress, 0.3, 0.06) : `translate(${W / 2} ${H * 2})`);
      sun.setAttribute("transform", dayProgress >= 0 && dayProgress <= 1 ? arc(dayProgress, 0.3, 0.05) : `translate(${W / 2} ${H * 2})`);
    }
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
    // The struck building lights up, even if the battery had already switched it off, and a surge
    // of current runs down the power line.
    target.el.classList.add("hit");
    root.classList.add("surge");
    setTimeout(() => root.classList.remove("surge"), perfect ? 1400 : 900);
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

  // The power line: from the battery's tip out to the side (the screen edge on a phone, the open
  // sky beside the game on a wide screen), then down into the roof of the building below.
  function placeCable() {
    cancelAnimationFrame(cableFrame);
    cableFrame = requestAnimationFrame(() => {
      const svg = root.querySelector(".city-cable");
      if (!svg) return;
      const battery = cableSource?.();
      const box = battery?.getBoundingClientRect();
      if (!box || !box.width || document.body.classList.contains("starting")) {
        svg.classList.add("off");
        return;
      }
      const vw = window.innerWidth, vh = window.innerHeight;
      const phone = vw < 600;
      const startX = box.right + 8, startY = box.top + box.height / 2;
      const edgeX = phone ? vw - 7 : Math.min(vw - 24, Math.max(box.right + 60, (vw + 720) / 2 + 48));
      // The roof under the line: the tallest building it would run into.
      const under = buildings.filter(b => b.x <= edgeX && edgeX <= b.x + b.w);
      const roof = under.length ? Math.min(...under.map(b => b.top)) : H;
      const endY = vh - (H - roof);
      const bend = Math.min(14, Math.abs(edgeX - startX) / 2, Math.max(0, endY - startY) / 2);
      const d = endY > startY + bend
        ? `M${startX.toFixed(1)},${startY.toFixed(1)} H${(edgeX - bend).toFixed(1)} Q${edgeX.toFixed(1)},${startY.toFixed(1)} ${edgeX.toFixed(1)},${(startY + bend).toFixed(1)} V${endY.toFixed(1)}`
        : `M${startX.toFixed(1)},${startY.toFixed(1)} H${edgeX.toFixed(1)}`;
      svg.setAttribute("viewBox", `0 0 ${vw} ${vh}`);
      svg.querySelectorAll("path").forEach(path => path.setAttribute("d", d));
      svg.classList.remove("off");
    });
  }

  build();
  // Hard mode, the start screen and the out-of-charge screen are all body classes.
  new MutationObserver(() => { refresh(); placeCable(); }).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  // The line follows the battery as the page scrolls or its layout changes.
  window.addEventListener("scroll", placeCable, { passive: true });
  new ResizeObserver(placeCable).observe(document.body);
  document.fonts?.ready.then(placeCable);
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (window.innerWidth !== builtWidth) build(); else placeCable(); }, 200);
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
    // Plugs the power line into a battery (a function returning the element, checked on each update).
    connect(source) {
      cableSource = source;
      placeCable();
    },
    layout: placeCable,
    strike,
    fireworks
  };
}
