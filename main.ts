// SPDX-License-Identifier: MIT
// "Steaming Tonkotsu" — food-picture-01 entry (Node 22, standard library only).
//
// A fully procedural picture drawn one pixel at a time from signed-distance
// shapes and smooth value noise: no image files, no network, no randomness.
// Every pixel is a fixed function of its coordinates, so two runs write
// byte-identical PNG output.
//
// Subject: a bowl of tonkotsu ramen seen from a slight overhead angle on a
// dark wooden table — creamy broth with glossy oil droplets, a springy
// noodle mass with hero strands, two seared chashu slices, two halved
// ajitama eggs with jammy yolks, dark nori sheets, scattered spring-onion
// rings, and a pair of chopsticks lifting a bundle of noodles through soft
// steam. Warm dramatic light, deep shadows, everything leading the eye to
// the bowl.
//
// Run it the way the grader does:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1024;
const H = 1024;
const SS = 2; // 2x2 supersampling for clean anti-aliased edges

// ---------------------------------------------------------------- helpers --

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function mixc(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function smooth(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function sdEllipse(px, py, cx, cy, rx, ry) {
  const dx = (px - cx) / rx;
  const dy = (py - cy) / ry;
  const q = Math.sqrt(dx * dx + dy * dy);
  return (q - 1) * Math.min(rx, ry);
}
function sdCircle(px, py, cx, cy, r) {
  const dx = px - cx, dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  const dx = pax - bax * h, dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy);
}
// Signed distance to a rotated rectangle centred at (cx, cy).
function sdBoxRot(px, py, cx, cy, hx, hy, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const dx = px - cx, dy = py - cy;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  const qx = Math.abs(lx) - hx, qy = Math.abs(ly) - hy;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0);
}
// Coverage of a shape from its signed distance (negative = inside).
function cov(d, feather) { return clamp01(0.5 - d / (2 * feather)); }
// Alpha-blend colour fg over bg with coverage a.
function over(bg, fg, a) {
  return [lerp(bg[0], fg[0], a), lerp(bg[1], fg[1], a), lerp(bg[2], fg[2], a)];
}

// Deterministic value noise: a hashed integer lattice, smoothly interpolated.
function hash2(ix, iy) {
  let n = (ix * 374761393 + iy * 668265263) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}
function fbm(x, y, oct) {
  let v = 0, amp = 0.5, f = 1, tot = 0;
  for (let i = 0; i < oct; i++) {
    v += amp * vnoise(x * f, y * f);
    tot += amp; amp *= 0.5; f *= 2.03;
  }
  return v / tot;
}
// Tiny deterministic per-pixel hash for dithering (breaks gradient banding).
function dither(x, y) {
  return hash2(x * 7 + 13, y * 7 + 29) - 0.5;
}

// ------------------------------------------------------------- scene data --

// Bowl geometry (normalised coordinates, y down).
const BCX = 0.5, BCY = 0.565;          // bowl centre
const BRX = 0.365, BRY = 0.295;        // outer rim ellipse
const KRX = 0.322, KRY = 0.254;        // broth surface ellipse
const KCY = BCY - 0.006;               // broth centre height

// Hero noodle strands lying on the broth. Two families, both generated with
// a deterministic LCG so the layout is identical on every run: loose wavy
// strands that wander across the bowl, and tight coils (little noodle nests)
// that read as a springy noodle mass even at thumbnail size.
const brothStrands = [];
{
  let seed = 1234567;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    return ((seed >>> 0) % 10000) / 10000;
  };
  const clampToBroth = (x, y) => {
    const ex = (x - BCX) / (KRX * 0.96), ey = (y - KCY) / (KRY * 0.94);
    const q = Math.sqrt(ex * ex + ey * ey);
    if (q <= 1) return [x, y];
    return [BCX + ex / q * KRX * 0.96, KCY + ey / q * KRY * 0.94];
  };
  // Wavy wanderers: two sine octaves so they never look ruled straight.
  for (let i = 0; i < 11; i++) {
    const yBase = KCY - KRY * 0.58 + (i / 11) * KRY * 1.16 + (rnd() - 0.5) * 0.02;
    const amp1 = 0.014 + rnd() * 0.016, amp2 = 0.005 + rnd() * 0.007;
    const per1 = 1.1 + rnd() * 1.3, per2 = 3.0 + rnd() * 2.0;
    const ph = rnd() * 6.283, ph2 = rnd() * 6.283;
    const drift = (rnd() - 0.5) * 0.05;
    const x0 = BCX - KRX * (0.5 + rnd() * 0.36);
    const x1 = BCX + KRX * (0.5 + rnd() * 0.36);
    const pts = [];
    const N = 22;
    for (let j = 0; j <= N; j++) {
      const t = j / N;
      const x = lerp(x0, x1, t);
      const y = yBase + drift * (t - 0.5)
        + Math.sin(t * per1 * 6.283 + ph) * amp1
        + Math.sin(t * per2 * 6.283 + ph2) * amp2;
      pts.push(clampToBroth(x, y));
    }
    brothStrands.push({ pts, r: 0.0058 + rnd() * 0.0022, ph });
  }
  // Coils: loose expanding spirals around five nest centres — few turns
  // and thick strands, so they read as noodle nests, not fingerprints.
  const nests = [[0.40, 0.50], [0.55, 0.44], [0.63, 0.63], [0.44, 0.65], [0.545, 0.555]];
  for (const [nx, ny] of nests) {
    for (let k = 0; k < 3; k++) {
      const pts = [];
      const turns = 1.05 + rnd() * 0.55;
      const r0 = 0.007 + k * 0.004, r1 = 0.032 + rnd() * 0.020 + k * 0.007;
      const ph = rnd() * 6.283;
      const N = 30;
      for (let j = 0; j <= N; j++) {
        const t = j / N;
        const a = ph + t * turns * 6.283;
        const rr = lerp(r0, r1, t);
        pts.push(clampToBroth(nx + Math.cos(a) * rr, ny + Math.sin(a) * rr * 0.78));
      }
      brothStrands.push({ pts, r: 0.0062 + rnd() * 0.0020, ph });
    }
  }
}
// Noodle bundle lifted by the chopsticks: strands hanging from the grip.
const GRIP = [0.615, 0.255];
const liftStrands = [];
{
  let seed = 987654;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    return ((seed >>> 0) % 10000) / 10000;
  };
  for (let i = 0; i < 9; i++) {
    const len = 0.16 + rnd() * 0.13;
    const sway = (rnd() - 0.5) * 0.03;
    const gx = GRIP[0] + (rnd() - 0.5) * 0.018;
    const pts = [];
    const N = 12;
    for (let j = 0; j <= N; j++) {
      const t = j / N;
      const x = gx + Math.sin(t * 3.4 + i * 1.7) * 0.011 * t + Math.sin(t * 7.3 + i) * 0.003 * t + sway * t * t;
      const y = GRIP[1] + len * t;
      pts.push([x, y]);
    }
    liftStrands.push({ pts, r: 0.0046 + rnd() * 0.0016, ph: i * 1.3 });
  }
}
// Spring-onion rings scattered over the broth.
const onions = [];
{
  let seed = 24681357;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    return ((seed >>> 0) % 10000) / 10000;
  };
  // A generous pile near the middle, a sparse scatter elsewhere.
  for (let i = 0; i < 30; i++) {
    let x, y;
    if (i < 16) {
      const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * 0.055;
      x = 0.52 + Math.cos(a) * rr;
      y = 0.545 + Math.sin(a) * rr * 0.8;
    } else {
      const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * 0.85;
      x = BCX + Math.cos(a) * rr * KRX * 0.9;
      y = KCY + Math.sin(a) * rr * KRY * 0.86;
    }
    onions.push([x, y, 0.0045 + rnd() * 0.004]);
  }
}
// Glossy oil droplets floating on the broth.
const oils = [];
{
  let seed = 1357924;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    return ((seed >>> 0) % 10000) / 10000;
  };
  for (let i = 0; i < 26; i++) {
    const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * 0.9;
    const x = BCX + Math.cos(a) * rr * KRX * 0.94;
    const y = KCY + Math.sin(a) * rr * KRY * 0.9;
    oils.push([x, y, 0.004 + rnd() * 0.011]);
  }
}

function strandDist(px, py, pts) {
  let d = 1e9;
  for (let j = 0; j < pts.length - 1; j++) {
    const dd = sdSegment(px, py, pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1]);
    if (dd < d) d = dd;
  }
  return d;
}

// ---------------------------------------------------------------- shading --

function shade(x, y) {
  // ---- table: dark warm wood with soft grain and a pool of light ----
  const grain = fbm(x * 26, y * 5, 3);
  let col = mixc([0.105, 0.062, 0.038], [0.185, 0.115, 0.066], grain);
  const seam = smooth(0.012, 0.0, Math.abs(((y * 5 + fbm(x * 3, y * 3, 2) * 0.05) % 1 + 1) % 1 - 0.5) - 0.47);
  col = mixc(col, [0.06, 0.035, 0.02], seam * 0.22);
  const glow = Math.exp(-(((x - 0.5) ** 2) / 0.16 + ((y - 0.52) ** 2) / 0.13));
  col = mixc(col, [0.32, 0.20, 0.115], glow * 0.55);
  // scattered sesame / crumbs sparkle on the table, very subtle
  const spark = vnoise(x * 300, y * 300);
  if (spark > 0.985) col = mixc(col, [0.75, 0.62, 0.4], 0.35);

  // ---- soft shadow under the bowl ----
  const shD = sdEllipse(x, y, BCX, BCY + 0.045, BRX * 1.06, BRY * 1.02);
  col = mixc([0.03, 0.018, 0.012], col, smooth(-0.06, 0.05, shD));

  // ---- bowl exterior: deep indigo-black ceramic ----
  const outerD = sdEllipse(x, y, BCX, BCY, BRX, BRY);
  const innerD = sdEllipse(x, y, BCX, KCY, KRX, KRY);
  if (outerD < 0.01) {
    // body: everything inside the rim but outside the broth, plus the
    // lower bowl wall shading toward the foot.
    const t = clamp01((y - (BCY - BRY)) / (2 * BRY));
    let body = mixc([0.13, 0.135, 0.17], [0.045, 0.045, 0.065], smooth(0.25, 1, t));
    // a warm bounce from the table on the lower wall
    body = mixc(body, [0.20, 0.11, 0.06], smooth(0.72, 1, t) * 0.35);
    // speckled ceramic texture
    const sp = fbm(x * 90, y * 90, 2);
    body = mixc(body, [0.22, 0.22, 0.26], (sp - 0.5) * 0.25);
    // rim light on the upper-left edge
    const rim = smooth(0.006, -0.002, outerD) * smooth(0.35, 0.05, Math.abs(y - (BCY - BRY * 0.72)) + Math.abs(x - BCX - 0.1));
    body = mixc(body, [0.55, 0.55, 0.6], rim * 0.5);
    col = over(col, body, cov(outerD, 0.0035));
    // foot ring
    const footD = sdEllipse(x, y, BCX, BCY + BRY * 0.94, 0.115, 0.028);
    col = over(col, [0.06, 0.06, 0.08], cov(footD, 0.003) * 0.9);
  }

  // ---- everything on the broth surface ----
  if (innerD < 0.006) {
    // creamy tonkotsu broth: pale gold, deeper at the edges, bright centre
    const er = clamp01(Math.sqrt(((x - BCX) / KRX) ** 2 + ((y - KCY) / KRY) ** 2));
    let food = mixc([0.96, 0.845, 0.58], [0.79, 0.55, 0.295], smooth(0.35, 1.05, er));
    const brothNoise = fbm(x * 14 + 7, y * 14, 3);
    food = mixc(food, [0.90, 0.68, 0.40], (brothNoise - 0.5) * 0.35);
    // fatty swirls: paler marbling drifting through the broth
    const swirl = fbm(x * 6 - y * 4, y * 6 + x * 3, 3);
    food = mixc(food, [0.985, 0.92, 0.72], smooth(0.55, 0.8, swirl) * 0.5);

    // noodle mass under the surface: a fine diagonal strand pattern in
    // pale wheat, kept very low-contrast so it whispers texture under the
    // hero strands instead of drawing stripes of its own
    const wave = Math.sin(((x + y * 0.7) * 210 + fbm(x * 9, y * 9, 2) * 30) + Math.sin(y * 130 + x * 40) * 1.1);
    const mass = smooth(0.05, 0.7, wave * 0.5 + 0.5) * smooth(0.30, 0.60, fbm(x * 5 + 31, y * 5, 2));
    food = mixc(food, [0.95, 0.815, 0.50], mass * 0.30);
    food = mixc(food, [0.845, 0.63, 0.315], smooth(0.8, 0.25, wave * 0.5 + 0.5) * mass * 0.14);

    // glossy oil droplets
    for (let i = 0; i < oils.length; i++) {
      const d = sdCircle(x, y, oils[i][0], oils[i][1], oils[i][2]);
      if (d < 0.004) {
        food = mixc(food, [0.99, 0.90, 0.60], cov(d, 0.0018) * 0.55);
      }
    }

    // ---- nori sheets standing at the back of the bowl ----
    for (const [nx, ny, ang] of [[0.345, 0.375, -0.14], [0.405, 0.362, -0.03]]) {
      const d = sdBoxRot(x, y, nx, ny, 0.040, 0.062, ang);
      if (d < 0.004) {
        const sheen = fbm(x * 40, y * 40, 2);
        let nori = mixc([0.030, 0.048, 0.034], [0.065, 0.105, 0.065], sheen);
        nori = mixc(nori, [0.22, 0.30, 0.20], smooth(0.003, -0.004, d) * 0.22);
        food = over(food, nori, cov(d, 0.0022));
      }
    }

    // ---- hero noodle strands on the surface: soft shadow pass first so
    // the strands sit IN the broth, then the lit strand itself ----
    for (let i = 0; i < brothStrands.length; i++) {
      const s = brothStrands[i];
      const dSh = strandDist(x, y + 0.005, s.pts) - s.r * 1.15;
      if (dSh < 0.004) food = mixc(food, [0.62, 0.42, 0.19], cov(dSh, 0.0025) * 0.35);
    }
    for (let i = 0; i < brothStrands.length; i++) {
      const s = brothStrands[i];
      const d = strandDist(x, y, s.pts) - s.r;
      if (d < 0.004) {
        const a = cov(d, 0.0016);
        // cylindrical shading across the strand using the distance gradient
        const core = clamp01(1 - Math.abs(d + s.r * 0.4) / (s.r * 1.4));
        let nc = mixc([0.835, 0.615, 0.30], [0.955, 0.825, 0.51], core);
        nc = mixc(nc, [1.0, 0.93, 0.70], smooth(0.78, 1, core) * 0.30);
        food = over(food, nc, a);
      }
    }

    // ---- chashu slices: seared rolled pork, left of centre. Irregular
    // outline and fbm marbling instead of perfect rings, so they read as
    // meat, not donuts ----
    for (const [hx, hy, hr, rot] of [[0.375, 0.545, 0.082, 0.4], [0.44, 0.605, 0.077, 2.2]]) {
      const angC = Math.atan2(y - hy, x - hx);
      const wob = 1 + (fbm(Math.cos(angC) * 2 + hx * 40, Math.sin(angC) * 2 + rot * 9, 2) - 0.5) * 0.14;
      const d = sdEllipse(x, y, hx, hy, hr * wob, hr * 0.86 * wob);
      if (d < 0.006) {
        // soft shadow where the slice sits in the broth
        const dSh = sdEllipse(x, y + 0.006, hx, hy, hr * wob, hr * 0.86 * wob);
        food = mixc(food, [0.60, 0.40, 0.18], cov(dSh, 0.003) * 0.30);
        const dd = Math.sqrt((x - hx) ** 2 + (y - hy) ** 2);
        const marb = fbm(x * 34 + rot * 20, y * 34, 3);
        let meat = mixc([0.615, 0.285, 0.175], [0.735, 0.395, 0.245], marb);
        // pale fat patches where the noise runs high
        meat = mixc(meat, [0.94, 0.79, 0.615], smooth(0.55, 0.75, marb) * 0.8);
        // a lean rosier heart
        meat = mixc(meat, [0.52, 0.225, 0.145], smooth(hr * 0.55, hr * 0.15, dd) * 0.30);
        // seared dark rim: driven by radial distance so only the outer
        // ring chars, never the middle of the slice
        meat = mixc(meat, [0.30, 0.13, 0.065], smooth(0.80, 0.99, dd / (hr * wob)) * 0.75);
        // juicy gloss
        const gl = Math.exp(-(((x - hx + hr * 0.3) ** 2) / 0.0012 + ((y - hy + hr * 0.35) ** 2) / 0.0006));
        meat = mixc(meat, [1.0, 0.85, 0.65], gl * 0.32);
        food = over(food, meat, cov(d, 0.0022));
      }
    }

    // ---- ajitama egg halves: glossy jammy yolks, right of centre ----
    for (const [ex, ey, er, rot] of [[0.615, 0.575, 0.062, 0.5], [0.665, 0.50, 0.055, 2.4]]) {
      const d = sdEllipse(x, y, ex, ey, er, er * 0.88);
      if (d < 0.006) {
        // shadow so the white lifts off the pale broth
        const dSh = sdEllipse(x, y + 0.005, ex, ey, er, er * 0.88);
        food = mixc(food, [0.62, 0.44, 0.20], cov(dSh, 0.003) * 0.32);
        let egg = [0.985, 0.965, 0.915];
        const marinade = smooth(0.002, -0.016, d);
        egg = mixc(egg, [0.855, 0.635, 0.40], marinade * 0.55);
        food = over(food, egg, cov(d, 0.002));
        // yolk: molten golden centre, deep orange rim, shaded lower crescent
        const yd = sdEllipse(x, y, ex, ey, er * 0.63, er * 0.56);
        if (yd < 0.004) {
          const yr = clamp01(Math.sqrt(((x - ex) / (er * 0.63)) ** 2 + ((y - ey) / (er * 0.56)) ** 2));
          let yolk = mixc([1.0, 0.735, 0.175], [0.925, 0.455, 0.055], smooth(0.30, 1.0, yr));
          yolk = mixc(yolk, [0.85, 0.36, 0.04], smooth(0.02, 0.20, y - ey) * 0.30);
          const gl = Math.exp(-(((x - ex + er * 0.16) ** 2) / 0.00035 + ((y - ey + er * 0.18) ** 2) / 0.0002));
          yolk = mixc(yolk, [1.0, 0.93, 0.65], gl * 0.6);
          food = over(food, yolk, cov(yd, 0.0018));
        }
      }
    }

    // ---- spring-onion rings over everything: deeper greens, soft light ----
    for (let i = 0; i < onions.length; i++) {
      const [ox, oy, orr] = onions[i];
      const d = sdCircle(x, y, ox, oy, orr);
      if (d < 0.003) {
        const inner = sdCircle(x, y, ox, oy, orr * 0.52);
        let oc = inner < 0 ? [0.52, 0.76, 0.34] : [0.175, 0.46, 0.145];
        oc = mixc(oc, [0.78, 0.93, 0.52], smooth(0.002, -0.002, d) * 0.35);
        food = over(food, oc, cov(d, 0.0011));
      }
    }

    col = over(col, food, cov(innerD, 0.003));
  }

  // ---- steam: soft wisps curling up from the broth ----
  {
    const rise = smooth(0.52, 0.30, y) * smooth(0.06, 0.30, y);
    if (rise > 0.001) {
      const curl = fbm(x * 7 + y * 3.5, y * 5 - 1.5, 3);
      const wisp = Math.exp(-(((x - 0.46 - (0.5 - y) * 0.06) ** 2) / 0.006)) * 0.7
        + Math.exp(-(((x - 0.58 - (0.5 - y) * 0.04) ** 2) / 0.004)) * 0.55
        + Math.exp(-(((x - 0.38 - (0.5 - y) * 0.08) ** 2) / 0.003)) * 0.4;
      const a = clamp01(wisp * rise * (0.35 + curl * 0.75)) * 0.30;
      col = over(col, [0.98, 0.97, 0.95], a);
    }
  }

  // ---- lifted noodle bundle (only near the chopstick grip) ----
  if (x > 0.52 && x < 0.72 && y > 0.22 && y < 0.60) for (let i = 0; i < liftStrands.length; i++) {
    const s = liftStrands[i];
    const d = strandDist(x, y, s.pts) - s.r;
    if (d < 0.004) {
      const core = clamp01(1 - Math.abs(d + s.r * 0.4) / (s.r * 1.4));
      let nc = mixc([0.80, 0.60, 0.29], [0.965, 0.85, 0.53], core);
      nc = mixc(nc, [1.0, 0.94, 0.72], smooth(0.75, 1, core) * 0.38);
      // broth droplets clinging to the strands glisten
      col = over(col, nc, cov(d, 0.0016));
    }
  }

  // ---- chopsticks: warm wood, entering from the top right ----
  for (const off of [0, 0.021]) {
    const ax = 0.985, ay = 0.015 + off * 0.4;
    const bx = GRIP[0] + off * 0.55, by = GRIP[1] + off;
    const d = sdSegment(x, y, ax, ay, bx, by);
    // taper: thinner near the tip
    const along = clamp01(((x - bx) * (ax - bx) + (y - by) * (ay - by)) / ((ax - bx) ** 2 + (ay - by) ** 2));
    const r = lerp(0.0032, 0.0075, along);
    const dd = d - r;
    if (dd < 0.004) {
      let wood = mixc([0.42, 0.235, 0.10], [0.62, 0.39, 0.19], fbm(x * 60, y * 8, 2));
      wood = mixc(wood, [0.85, 0.62, 0.36], smooth(0.002, -0.003, dd) * 0.35);
      col = over(col, wood, cov(dd, 0.0016));
    }
  }

  // ---- final grade: warm light, gentle vignette ----
  const vig = 1 - 0.38 * smooth(0.45, 1.05, Math.sqrt((x - 0.5) ** 2 + (y - 0.48) ** 2));
  const key = 1 + 0.10 * Math.exp(-(((x - 0.34) ** 2) / 0.2 + ((y - 0.30) ** 2) / 0.16));
  return [col[0] * vig * key * 1.04, col[1] * vig * key, col[2] * vig * key * 0.94];
}

// ------------------------------------------------------------------- PNG --

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  // Per-row adaptive filtering: try None/Sub/Up/Average/Paeth and keep the
  // row whose filtered bytes have the smallest signed-byte energy. Smooth
  // gradients compress far better this way, keeping the file under 1 MiB.
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  const cand = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);
  for (let yy = 0; yy < h; yy++) {
    const rowOff = yy * stride;
    const upOff = yy > 0 ? (yy - 1) * stride : -1;
    let bestType = 0, bestScore = Infinity;
    for (let ft = 0; ft <= 4; ft++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const cur = rgba[rowOff + i];
        const a = i >= 4 ? rgba[rowOff + i - 4] : 0;
        const b = upOff >= 0 ? rgba[upOff + i] : 0;
        const c = upOff >= 0 && i >= 4 ? rgba[upOff + i - 4] : 0;
        let pred = 0;
        if (ft === 1) pred = a;
        else if (ft === 2) pred = b;
        else if (ft === 3) pred = (a + b) >> 1;
        else if (ft === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (cur - pred) & 0xff;
        cand[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score; bestType = ft;
        cand.copy(best, 0, 0, stride);
      }
    }
    raw[yy * (stride + 1)] = bestType;
    best.copy(raw, yy * (stride + 1) + 1, 0, stride);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ main --

function render() {
  const rgba = Buffer.alloc(W * H * 4);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / W;
          const y = (py + (sy + 0.5) / SS) / H;
          const c = shade(x, y);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS;
      const dith = dither(px, py) * 0.006;
      const i = (py * W + px) * 4;
      rgba[i] = Math.round(clamp01(r / n + dith) * 255);
      rgba[i + 1] = Math.round(clamp01(g / n + dith) * 255);
      rgba[i + 2] = Math.round(clamp01(b / n + dith) * 255);
      rgba[i + 3] = 255;
    }
  }
  return encodePNG(W, H, rgba);
}

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), render());
