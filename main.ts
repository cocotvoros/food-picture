// SPDX-License-Identifier: MIT
// "Steaming Tonkotsu — The Noodle Pull" — food-picture-01 entry, overhaul
// (Node 22, standard library only).
//
// A fully procedural picture drawn one pixel at a time from signed-distance
// shapes, smooth value noise and several hundred little noodle strands kept
// in a spatial grid: no image files, no network, no randomness. Every pixel
// is a fixed function of its coordinates, so two runs write byte-identical
// PNG output. A final depth pass blurs only what sits outside the bowl, for
// a shallow depth-of-field feel.
//
// Subject: an extreme close-up of a tonkotsu ramen bowl that fills the
// frame, shot at 45 degrees. Chopsticks lift a tall, glossy bundle of
// noodles out of a creamy broth — the noodle pull is the hero. Around it:
// seared chashu with fat marbling, two ajitama halves with jammy yolks,
// nori, menma, spring onions, chilli oil and sesame, under warm dramatic
// light with soft steam curling through the top of the frame.
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
function sdBoxRot(px, py, cx, cy, hx, hy, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const dx = px - cx, dy = py - cy;
  const lx = dx * c + dy * s, ly = -dx * s + dy * c;
  const qx = Math.abs(lx) - hx, qy = Math.abs(ly) - hy;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0);
}
function cov(d, feather) { return clamp01(0.5 - d / (2 * feather)); }
function over(bg, fg, a) {
  return [lerp(bg[0], fg[0], a), lerp(bg[1], fg[1], a), lerp(bg[2], fg[2], a)];
}
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
function dither(x, y) { return hash2(x * 7 + 13, y * 7 + 29) - 0.5; }
// One deterministic LCG shared by all layout generation below.
function makeRnd(seed0) {
  let seed = seed0;
  return () => {
    seed = (Math.imul(seed, 1103515245) + 12345) | 0;
    return ((seed >>> 0) % 10000) / 10000;
  };
}

// ------------------------------------------------------------- scene data --

const BCX = 0.5, BCY = 0.64;           // bowl centre
const BRX = 0.435, BRY = 0.345;        // outer rim ellipse
const KRX = 0.378, KRY = 0.272;        // broth surface ellipse
const KCY = BCY - 0.012;               // broth centre height
const GRIP = [0.56, 0.175];            // chopstick grip point

function inBroth(x, y, scale) {
  const ex = (x - BCX) / (KRX * scale), ey = (y - KCY) / (KRY * scale);
  return ex * ex + ey * ey <= 1;
}
function clampToBroth(x, y, scale) {
  const ex = (x - BCX) / (KRX * scale), ey = (y - KCY) / (KRY * scale);
  const q = Math.sqrt(ex * ex + ey * ey);
  if (q <= 1) return [x, y];
  return [BCX + ex / q * KRX * scale, KCY + ey / q * KRY * scale];
}

// Dense noodle mass: hundreds of short curved strands wandering inside the
// broth, stored in a spatial grid so each pixel only tests its neighbours.
const CELL = 0.075;
const grid = new Map();
function gridKey(cx, cy) { return cx * 1000 + cy; }
function addToGrid(pts, r, tone) {
  // Register each strand once, in the cell holding its midpoint: strands
  // are short (<= ~0.1), so a 3x3 neighbourhood of 0.06 cells always
  // reaches every strand that can touch a pixel.
  const mid = pts[Math.floor(pts.length / 2)];
  const k = gridKey(Math.floor(mid[0] / CELL), Math.floor(mid[1] / CELL));
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push({ pts, r, tone });
}
{
  const rnd = makeRnd(20261114);
  for (let i = 0; i < 880; i++) {
    // random start inside the broth, random walk with gentle curvature
    const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * 0.9;
    let x = BCX + Math.cos(a) * rr * KRX * 0.94;
    let y = KCY + Math.sin(a) * rr * KRY * 0.9;
    let dir = rnd() * 6.283;
    const steps = 6 + Math.floor(rnd() * 4);
    const stepLen = 0.015 + rnd() * 0.010;
    const pts = [[x, y]];
    for (let j = 0; j < steps; j++) {
      dir += (rnd() - 0.5) * 1.5;
      x += Math.cos(dir) * stepLen;
      y += Math.sin(dir) * stepLen * 0.8;
      pts.push(clampToBroth(x, y, 0.94));
    }
    addToGrid(pts, 0.0062 + rnd() * 0.0036, rnd());
  }
  // Loose wavy hero strands crossing the bowl, on top of the mass.
  for (let i = 0; i < 12; i++) {
    const yBase = KCY - KRY * 0.55 + (i / 12) * KRY * 1.1 + (rnd() - 0.5) * 0.02;
    const amp1 = 0.013 + rnd() * 0.015, per1 = 1.1 + rnd() * 1.2;
    const ph = rnd() * 6.283, drift = (rnd() - 0.5) * 0.05;
    const x0 = BCX - KRX * (0.5 + rnd() * 0.36), x1 = BCX + KRX * (0.5 + rnd() * 0.36);
    const pts = [];
    for (let j = 0; j <= 20; j++) {
      const t = j / 20;
      pts.push(clampToBroth(lerp(x0, x1, t),
        yBase + drift * (t - 0.5) + Math.sin(t * per1 * 6.283 + ph) * amp1, 0.96));
    }
    addToGrid(pts, 0.0062 + rnd() * 0.002, rnd());
  }
}
function massDist(x, y) {
  const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
  let best = 1e9, tone = 0.5;
  for (let ix = cx - 1; ix <= cx + 1; ix++) for (let iy = cy - 1; iy <= cy + 1; iy++) {
    const cell = grid.get(gridKey(ix, iy));
    if (!cell) continue;
    for (const rec of cell) {
      for (let j = 0; j < rec.pts.length - 1; j++) {
        const dd = sdSegment(x, y, rec.pts[j][0], rec.pts[j][1], rec.pts[j + 1][0], rec.pts[j + 1][1]) - rec.r;
        if (dd < best) { best = dd; tone = rec.tone; }
      }
    }
  }
  return [best, tone];
}

// The noodle pull: a tall bundle hanging from the grip, strands that bow
// outward then fall, each with its own length and sway.
const liftStrands = [];
{
  const rnd = makeRnd(987654);
  for (let i = 0; i < 23; i++) {
    // three short "peelers" escape the bundle early; the rest cascade down
    const peeler = i >= 20;
    const len = peeler ? 0.17 + rnd() * 0.09 : 0.31 + rnd() * 0.155;
    const gx = GRIP[0] + (rnd() - 0.5) * 0.042;
    const bow = peeler ? (rnd() < 0.5 ? -1 : 1) * (0.05 + rnd() * 0.05)
      : (rnd() - 0.5) * 0.085;      // sideways bow of the cascade
    const swayPh = rnd() * 6.283;
    const pts = [];
    const N = 16;
    for (let j = 0; j <= N; j++) {
      const t = j / N;
      // peelers drift steadily outward as they fall (escaping strands);
      // cascade strands bow out and settle back toward the bundle
      const bowCurve = peeler ? bow * t * t : bow * Math.sin(t * Math.PI) * (0.4 + 0.6 * t);
      const x = gx + bowCurve + Math.sin(t * 5.2 + swayPh) * 0.008 * t;
      const y = GRIP[1] + len * t;
      pts.push([x, y]);
    }
    liftStrands.push({ pts, r: 0.0052 + rnd() * 0.0023, tone: rnd() });
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

// Spring-onion rings: a pile plus a sparse scatter.
const onions = [];
{
  const rnd = makeRnd(24681357);
  for (let i = 0; i < 34; i++) {
    let x, y;
    if (i < 18) {
      const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * 0.06;
      x = 0.525 + Math.cos(a) * rr; y = 0.735 + Math.sin(a) * rr * 0.8;
    } else {
      const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * 0.85;
      x = BCX + Math.cos(a) * rr * KRX * 0.9; y = KCY + Math.sin(a) * rr * KRY * 0.86;
    }
    onions.push([x, y, 0.0048 + rnd() * 0.0042]);
  }
}
// Oil droplets (golden) and chilli-oil droplets (deep red) on the broth.
const oils = [];
const chilli = [];
{
  const rnd = makeRnd(1357924);
  for (let i = 0; i < 30; i++) {
    const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * 0.92;
    oils.push([BCX + Math.cos(a) * rr * KRX * 0.94, KCY + Math.sin(a) * rr * KRY * 0.9, 0.004 + rnd() * 0.012]);
  }
  for (let i = 0; i < 16; i++) {
    const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * 0.85;
    chilli.push([BCX + Math.cos(a) * rr * KRX * 0.9, KCY + Math.sin(a) * rr * KRY * 0.86, 0.003 + rnd() * 0.007]);
  }
}
// Sesame seeds scattered over the front toppings.
const sesame = [];
{
  const rnd = makeRnd(555111);
  for (let i = 0; i < 42; i++) {
    const zone = rnd();
    let x, y;
    if (zone < 0.45) { const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * 0.075; x = 0.375 + Math.cos(a) * rr; y = 0.695 + Math.sin(a) * rr * 0.8; }
    else if (zone < 0.75) { const a = rnd() * 6.283, rr = Math.sqrt(rnd()) * 0.05; x = 0.70 + Math.cos(a) * rr; y = 0.65 + Math.sin(a) * rr * 0.8; }
    else { x = 0.42 + rnd() * 0.3; y = 0.72 + rnd() * 0.1; }
    sesame.push([x, y, rnd() * 3.14]);
  }
}

// ---------------------------------------------------------------- shading --

function shade(x, y) {
  // ---- table: near-black warm wood, mostly lost in shadow at this range --
  const grain = fbm(x * 22, y * 5, 3);
  let col = mixc([0.075, 0.045, 0.028], [0.14, 0.088, 0.05], grain);
  const glow = Math.exp(-(((x - 0.5) ** 2) / 0.17 + ((y - 0.55) ** 2) / 0.15));
  col = mixc(col, [0.26, 0.16, 0.09], glow * 0.5);

  // ---- soft shadow under the bowl ----
  const shD = sdEllipse(x, y, BCX, BCY + 0.05, BRX * 1.05, BRY * 1.0);
  col = mixc([0.022, 0.013, 0.009], col, smooth(-0.05, 0.05, shD));

  // ---- bowl exterior: deep indigo-black ceramic with a sheen band ----
  const outerD = sdEllipse(x, y, BCX, BCY, BRX, BRY);
  const innerD = sdEllipse(x, y, BCX, KCY, KRX, KRY);
  if (outerD < 0.012) {
    const t = clamp01((y - (BCY - BRY)) / (2 * BRY));
    let body = mixc([0.115, 0.12, 0.155], [0.038, 0.038, 0.056], smooth(0.22, 1, t));
    body = mixc(body, [0.19, 0.105, 0.055], smooth(0.72, 1, t) * 0.35);
    const sp = fbm(x * 80, y * 80, 2);
    body = mixc(body, [0.21, 0.21, 0.25], (sp - 0.5) * 0.28);
    // broad sheen sweeping the front wall
    const sheen = Math.exp(-(((y - (BCY + BRY * 0.38)) ** 2) / 0.004)) * smooth(0.35, 0.0, Math.abs(x - 0.42));
    body = mixc(body, [0.34, 0.34, 0.38], sheen * 0.30);
    // rim light on the upper-left edge
    const rim = smooth(0.007, -0.002, outerD) * smooth(0.4, 0.05, Math.abs(y - (BCY - BRY * 0.7)) + Math.abs(x - BCX - 0.08));
    body = mixc(body, [0.55, 0.55, 0.6], rim * 0.5);
    col = over(col, body, cov(outerD, 0.0035));
    const footD = sdEllipse(x, y, BCX, BCY + BRY * 0.95, 0.13, 0.03);
    col = over(col, [0.05, 0.05, 0.068], cov(footD, 0.003) * 0.9);
  }

  // ---- everything on the broth surface ----
  if (innerD < 0.006) {
    const er = clamp01(Math.sqrt(((x - BCX) / KRX) ** 2 + ((y - KCY) / KRY) ** 2));
    let food = mixc([0.955, 0.835, 0.565], [0.775, 0.535, 0.285], smooth(0.3, 1.05, er));
    const brothNoise = fbm(x * 13 + 7, y * 13, 3);
    food = mixc(food, [0.885, 0.66, 0.385], (brothNoise - 0.5) * 0.38);
    const swirl = fbm(x * 6 - y * 4, y * 6 + x * 3, 3);
    food = mixc(food, [0.985, 0.915, 0.71], smooth(0.55, 0.8, swirl) * 0.5);
    // broad specular sheen of the key light on the broth, upper left
    const spec = Math.exp(-(((x - 0.36) ** 2) / 0.028 + ((y - 0.50) ** 2) / 0.010));
    food = mixc(food, [1.0, 0.96, 0.82], spec * 0.28);

    // dense noodle mass from the grid: thick strands in broth tones, the
    // submerged ones (low tone) showing through the broth at half strength
    // so the mass has depth instead of a neon wire pattern
    const [md, mtone] = massDist(x, y);
    if (md < 0.005) {
      const core = clamp01(1 - Math.abs(md + 0.0032) / 0.0090);
      let nc = mixc([0.825, 0.615, 0.31], [0.955, 0.83, 0.515], core);
      nc = mixc(nc, [0.875, 0.66, 0.345], (mtone - 0.5) * 0.30);
      nc = mixc(nc, [1.0, 0.945, 0.72], smooth(0.82, 1, core) * 0.26);
      const subm = mtone < 0.38 ? 0.5 : 1.0;
      const edgeFade = smooth(1.0, 0.88, er);
      food = over(food, nc, cov(md, 0.0016) * subm * (0.35 + 0.65 * edgeFade));
    }

    // oil + chilli droplets with a specular pip
    for (let i = 0; i < oils.length; i++) {
      const d = sdCircle(x, y, oils[i][0], oils[i][1], oils[i][2]);
      if (d < 0.004) {
        food = mixc(food, [0.99, 0.895, 0.585], cov(d, 0.0018) * 0.6);
        const pip = sdCircle(x, y, oils[i][0] - oils[i][2] * 0.3, oils[i][1] - oils[i][2] * 0.3, oils[i][2] * 0.32);
        food = mixc(food, [1.0, 0.99, 0.92], cov(pip, 0.001) * 0.7);
      }
    }
    for (let i = 0; i < chilli.length; i++) {
      const d = sdCircle(x, y, chilli[i][0], chilli[i][1], chilli[i][2]);
      if (d < 0.003) food = mixc(food, [0.78, 0.24, 0.05], cov(d, 0.0014) * 0.65);
    }

    // ---- nori sheets at the back of the bowl ----
    for (const [nx, ny, ang] of [[0.295, 0.475, -0.15], [0.355, 0.462, -0.04]]) {
      const d = sdBoxRot(x, y, nx, ny, 0.038, 0.06, ang);
      if (d < 0.004) {
        const sheen = fbm(x * 40, y * 40, 2);
        let nori = mixc([0.028, 0.045, 0.032], [0.062, 0.10, 0.062], sheen);
        nori = mixc(nori, [0.22, 0.30, 0.20], smooth(0.003, -0.004, d) * 0.22);
        food = over(food, nori, cov(d, 0.0022));
      }
    }

    // ---- menma: three bamboo shoots standing at the back right ----
    for (const [mx, my, ang] of [[0.775, 0.52, 0.5], [0.80, 0.545, 0.62], [0.755, 0.555, 0.38]]) {
      const d = sdBoxRot(x, y, mx, my, 0.011, 0.052, ang);
      if (d < 0.004) {
        let mm = mixc([0.76, 0.565, 0.30], [0.85, 0.68, 0.42], fbm(x * 50, y * 20, 2));
        mm = mixc(mm, [0.45, 0.30, 0.14], smooth(0.0025, -0.003, d) * 0.5);
        food = over(food, mm, cov(d, 0.0018));
      }
    }

    // ---- chashu: two big seared slices, front left ----
    for (const [hx, hy, hr, rot] of [[0.345, 0.665, 0.09, 0.4], [0.42, 0.735, 0.082, 2.2]]) {
      const angC = Math.atan2(y - hy, x - hx);
      const wob = 1 + (fbm(Math.cos(angC) * 2 + hx * 40, Math.sin(angC) * 2 + rot * 9, 2) - 0.5) * 0.13;
      const d = sdEllipse(x, y, hx, hy, hr * wob, hr * 0.86 * wob);
      if (d < 0.006) {
        const dSh = sdEllipse(x, y + 0.007, hx, hy, hr * wob, hr * 0.86 * wob);
        food = mixc(food, [0.585, 0.395, 0.175], cov(dSh, 0.0035) * 0.32);
        const dd = Math.sqrt((x - hx) ** 2 + (y - hy) ** 2);
        const marb = fbm(x * 30 + rot * 20, y * 30, 3);
        const marb2 = fbm(x * 65 + rot * 7, y * 65, 2);
        let meat = mixc([0.60, 0.275, 0.165], [0.725, 0.385, 0.235], marb * 0.75 + marb2 * 0.25);
        meat = mixc(meat, [0.94, 0.79, 0.615], smooth(0.58, 0.78, marb * 0.55 + marb2 * 0.45) * 0.8);
        meat = mixc(meat, [0.51, 0.215, 0.14], smooth(hr * 0.55, hr * 0.15, dd) * 0.30);
        // charred flecks near the rim
        const char = smooth(0.72, 0.9, fbm(x * 90 + rot * 31, y * 90, 2)) * smooth(0.72, 0.97, dd / (hr * wob));
        meat = mixc(meat, [0.16, 0.07, 0.04], char * 0.8);
        meat = mixc(meat, [0.30, 0.13, 0.065], smooth(0.82, 0.995, dd / (hr * wob)) * 0.7);
        const gl = Math.exp(-(((x - hx + hr * 0.3) ** 2) / 0.0013 + ((y - hy + hr * 0.35) ** 2) / 0.00065));
        meat = mixc(meat, [1.0, 0.86, 0.66], gl * 0.34);
        food = over(food, meat, cov(d, 0.0022));
      }
    }

    // ---- ajitama halves, right side ----
    for (const [ex, ey, er, rot] of [[0.665, 0.695, 0.066, 0.5], [0.72, 0.605, 0.058, 2.4]]) {
      const d = sdEllipse(x, y, ex, ey, er, er * 0.88);
      if (d < 0.006) {
        const dSh = sdEllipse(x, y + 0.006, ex, ey, er, er * 0.88);
        food = mixc(food, [0.60, 0.425, 0.19], cov(dSh, 0.003) * 0.32);
        let egg = [0.985, 0.965, 0.915];
        egg = mixc(egg, [0.85, 0.625, 0.395], smooth(0.002, -0.016, d) * 0.55);
        food = over(food, egg, cov(d, 0.002));
        const yd = sdEllipse(x, y, ex, ey, er * 0.63, er * 0.56);
        if (yd < 0.004) {
          const yr = clamp01(Math.sqrt(((x - ex) / (er * 0.63)) ** 2 + ((y - ey) / (er * 0.56)) ** 2));
          let yolk = mixc([1.0, 0.735, 0.175], [0.92, 0.45, 0.05], smooth(0.28, 1.0, yr));
          yolk = mixc(yolk, [0.845, 0.355, 0.035], smooth(0.02, 0.20, y - ey) * 0.30);
          const gl = Math.exp(-(((x - ex + er * 0.16) ** 2) / 0.0004 + ((y - ey + er * 0.18) ** 2) / 0.00022));
          yolk = mixc(yolk, [1.0, 0.93, 0.65], gl * 0.62);
          food = over(food, yolk, cov(yd, 0.0018));
        }
      }
    }

    // ---- spring-onion rings ----
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
    // ---- sesame seeds ----
    for (let i = 0; i < sesame.length; i++) {
      const [sx, sy, sa] = sesame[i];
      const d = sdEllipse(x, y, sx, sy, 0.0028, 0.0017);
      if (d < 0.002) food = over(food, [0.96, 0.90, 0.76], cov(d, 0.0009) * 0.75);
    }

    col = over(col, food, cov(innerD, 0.003));
  }

  // ---- shadow the lifted bundle casts on the bowl ----
  if (x > 0.44 && x < 0.72 && y > 0.30 && y < 0.72) {
    for (let i = 0; i < liftStrands.length; i++) {
      const s = liftStrands[i];
      const d = strandDist(x - 0.014, y - 0.022, s.pts) - s.r * 1.3;
      if (d < 0.006) col = mixc(col, [0.30, 0.19, 0.08], cov(d, 0.004) * 0.20);
    }
  }

  // ---- steam: layered volumetric wisps, lit from the left ----
  {
    const rise = smooth(0.55, 0.32, y) * smooth(0.02, 0.26, y);
    if (rise > 0.001) {
      const curl = fbm(x * 6 + y * 3.2, y * 4.6 - 1.5, 3);
      const curl2 = fbm(x * 13 - y * 2, y * 9 + 4, 2);
      let wisp = Math.exp(-(((x - 0.44 - (0.5 - y) * 0.07) ** 2) / 0.007)) * 0.75
        + Math.exp(-(((x - 0.60 - (0.5 - y) * 0.05) ** 2) / 0.005)) * 0.6
        + Math.exp(-(((x - 0.33 - (0.5 - y) * 0.09) ** 2) / 0.0035)) * 0.45
        + Math.exp(-(((x - 0.52 - (0.5 - y) * 0.03) ** 2) / 0.0028)) * 0.5;
      wisp *= 0.55 + curl * 0.65 + (curl2 - 0.5) * 0.3;
      const a = clamp01(wisp * rise) * 0.30;
      col = over(col, [0.985, 0.975, 0.955], a);
    }
  }

  // ---- the noodle pull itself: a soft dark-gold core behind the strands
  // so the bundle reads as separate noodles over shadow, not a solid slab --
  if (x > 0.44 && x < 0.70 && y > 0.15 && y < 0.66) {
    const dCore = sdSegment(x, y, GRIP[0], GRIP[1], GRIP[0] + 0.008, GRIP[1] + 0.37);
    col = mixc(col, [0.48, 0.325, 0.145], cov(dCore - 0.030, 0.020) * 0.42);
  }
  // ---- glossy broth-coated strands ----
  if (x > 0.42 && x < 0.72 && y > 0.14 && y < 0.68) {
    for (let i = 0; i < liftStrands.length; i++) {
      const s = liftStrands[i];
      const d = strandDist(x, y, s.pts) - s.r;
      if (d < 0.004) {
        const core = clamp01(1 - Math.abs(d + s.r * 0.35) / (s.r * 1.35));
        let nc = mixc([0.79, 0.575, 0.27], [0.97, 0.855, 0.535], core);
        nc = mixc(nc, [0.90, 0.685, 0.37], (s.tone - 0.5) * 0.3);
        // wet sheen: a bright thread down the lit side of each strand
        nc = mixc(nc, [1.0, 0.96, 0.78], smooth(0.72, 1, core) * 0.5);
        col = over(col, nc, cov(d, 0.0016));
      }
    }
  }

  // ---- chopsticks: warm wood from the top right, thicker at this range --
  for (const off of [0, 0.023]) {
    const ax = 0.995, ay = 0.008 + off * 0.4;
    const bx = GRIP[0] + off * 0.55, by = GRIP[1] + off;
    const d = sdSegment(x, y, ax, ay, bx, by);
    const along = clamp01(((x - bx) * (ax - bx) + (y - by) * (ay - by)) / ((ax - bx) ** 2 + (ay - by) ** 2));
    const r = lerp(0.0034, 0.0085, along);
    const dd = d - r;
    if (dd < 0.004) {
      let wood = mixc([0.40, 0.22, 0.095], [0.60, 0.375, 0.18], fbm(x * 55, y * 8, 2));
      wood = mixc(wood, [0.84, 0.61, 0.35], smooth(0.002, -0.003, dd) * 0.35);
      wood = mixc(wood, [0.18, 0.09, 0.04], smooth(0.75, 1.0, along) * 0.25);
      col = over(col, wood, cov(dd, 0.0016));
    }
  }

  // ---- final grade inside the pixel shader (vignette + warm key) ----
  const vig = 1 - 0.40 * smooth(0.42, 1.05, Math.sqrt((x - 0.5) ** 2 + (y - 0.46) ** 2));
  const key = 1 + 0.11 * Math.exp(-(((x - 0.33) ** 2) / 0.2 + ((y - 0.28) ** 2) / 0.16));
  return [col[0] * vig * key * 1.05, col[1] * vig * key, col[2] * vig * key * 0.93];
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
  ihdr[8] = 8;
  ihdr[9] = 6;
  // Per-row adaptive filtering keeps the smooth gradients small.
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
      if (score < bestScore) { bestScore = score; bestType = ft; cand.copy(best, 0, 0, stride); }
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
  // Pass 1: shade every pixel into a float buffer.
  const img = new Float32Array(W * H * 3);
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
      const n = SS * SS, i = (py * W + px) * 3;
      img[i] = r / n; img[i + 1] = g / n; img[i + 2] = b / n;
    }
  }
  // Pass 2: shallow depth of field — a separable box blur of the whole
  // frame, mixed in only where the pixel sits outside the bowl's focus
  // zone, so the table and the far corners melt while the food stays crisp.
  const tmp = new Float32Array(W * H * 3);
  const blur = new Float32Array(W * H * 3);
  const R = 5;
  for (let yy = 0; yy < H; yy++) {
    for (let xx = 0; xx < W; xx++) {
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let k = -R; k <= R; k++) {
        const sx = Math.min(W - 1, Math.max(0, xx + k));
        const i = (yy * W + sx) * 3;
        r += img[i]; g += img[i + 1]; b += img[i + 2]; cnt++;
      }
      const o = (yy * W + xx) * 3;
      tmp[o] = r / cnt; tmp[o + 1] = g / cnt; tmp[o + 2] = b / cnt;
    }
  }
  for (let yy = 0; yy < H; yy++) {
    for (let xx = 0; xx < W; xx++) {
      let r = 0, g = 0, b = 0, cnt = 0;
      for (let k = -R; k <= R; k++) {
        const sy = Math.min(H - 1, Math.max(0, yy + k));
        const i = (sy * W + xx) * 3;
        r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; cnt++;
      }
      const o = (yy * W + xx) * 3;
      blur[o] = r / cnt; blur[o + 1] = g / cnt; blur[o + 2] = b / cnt;
    }
  }
  const rgba = Buffer.alloc(W * H * 4);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const x = (px + 0.5) / W, y = (py + 0.5) / H;
      const od = sdEllipse(x, y, BCX, BCY, BRX, BRY);
      const f = smooth(0.015, 0.11, od) * 0.7;
      const i3 = (py * W + px) * 3, i4 = (py * W + px) * 4;
      const dith = dither(px, py) * 0.005;
      rgba[i4] = Math.round(clamp01(lerp(img[i3], blur[i3], f) + dith) * 255);
      rgba[i4 + 1] = Math.round(clamp01(lerp(img[i3 + 1], blur[i3 + 1], f) + dith) * 255);
      rgba[i4 + 2] = Math.round(clamp01(lerp(img[i3 + 2], blur[i3 + 2], f) + dith) * 255);
      rgba[i4 + 3] = 255;
    }
  }
  return encodePNG(W, H, rgba);
}

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), render());
