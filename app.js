/* THREE comes from vendor/three.global.js — see the note in index.html */

/* ───────────────────────── settings ───────────────────────── */

const DEFAULTS = {
  cols: 9, colsAuto: true, rows: 10, rowsAuto: true,
  gap: 0.06, spread: 2.0, offset: 0.5, crop: 0.2, radius: 0.03, drift: 0.04,
  globeSize: 0.60, tileScale: 0.95, taper: 0,
  spin: 0.16, tilt: 0.05, dur: 1.6, stagger: 0.55, bulge: 0.10,
  backs: true, loop: false, dwell: 4,
  word: 'OBJECTS', textColor: '#bdbdbd', textSize: 0.13,
  textTrack: 1.0, textLat: 0.0, textLift: 1.06,
  bgColor: '#ffffff'
};

const S = Object.assign({}, DEFAULTS, load());

function load() {
  try { return JSON.parse(localStorage.getItem('globe.settings') || '{}'); } catch { return {}; }
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('globe.settings', JSON.stringify(S)); } catch { /* file:// */ }
  }, 250);
}

/* crypto.randomUUID needs a secure context, which file:// isn't everywhere */
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  }));

/* ───────────────────────── image store ────────────────────── */

const DB_NAME = 'globe-images', STORE = 'imgs';
let dbp;
/* opened from file://, IndexedDB is unavailable in most browsers. The app still
   runs — it just can't remember uploads between visits, so every call degrades
   to a no-op instead of throwing. */
let storeOk = true;
function db() {
  return dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function tx(mode, fn) {
  if (!storeOk) return null;
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  } catch (e) {
    storeOk = false;
    console.warn('Image store unavailable — uploads will not persist between visits.', e);
    return null;
  }
}
const idbAll = () => tx('readonly', s => s.getAll());
const idbPut = rec => tx('readwrite', s => s.put(rec));
const idbDel = id => tx('readwrite', s => s.delete(id));
const idbClear = () => tx('readwrite', s => s.clear());

/* ───────────────────────── three setup ────────────────────── */

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(new THREE.Color(S.bgColor), 1);
const frameEl = document.getElementById('frame');
frameEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const CAM_Z = 10, FOV = 32;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
camera.position.z = CAM_Z;

const GEO = new THREE.PlaneGeometry(1, 1);

const VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

const FRAG = /* glsl */`
precision highp float;
uniform sampler2D uMap;
uniform vec2 uOff, uRep;
uniform float uRadius, uOpacity, uAspect;
varying vec2 vUv;
float sdRound(vec2 p, vec2 b, float r){
  vec2 q = abs(p) - b + r;
  return min(max(q.x,q.y),0.0) + length(max(q,0.0)) - r;
}
void main(){
  vec2 half_ = vec2(uAspect, 1.0) * 0.5;
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = uRadius * min(uAspect, 1.0);
  float d = sdRound(p, half_, r);
  float aa = max(fwidth(d), 1e-5);
  float edge = 1.0 - smoothstep(-aa, aa, d);
  vec4 c = texture2D(uMap, vUv * uRep + uOff);
  float a = c.a * edge * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(c.rgb, a);
  #include <colorspace_fragment>
}`;

function makeMaterial(tex, aspect, opts = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: tex },
      uOff: { value: new THREE.Vector2(0, 0) },
      uRep: { value: new THREE.Vector2(1, 1) },
      uRadius: { value: 0 },
      uOpacity: { value: 1 },
      uAspect: { value: aspect }
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: opts.depthWrite !== false,
    side: opts.side ?? THREE.DoubleSide
  });
}

/* ───────────────────────── viewport ───────────────────────── */

const view = { w: 0, h: 0, vw: 0, vh: 0 };
function resize() {
  const rect = frameEl.getBoundingClientRect();
  const w = Math.round(rect.width), h = Math.round(rect.height);
  if (!w || !h) return;                   // a 0-sized canvas makes the projection NaN
  view.w = w; view.h = h;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  view.vh = 2 * CAM_Z * Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
  view.vw = view.vh * camera.aspect;
  rebuildLayout();
}
addEventListener('resize', resize);

/* ───────────────────────── images ─────────────────────────── */

/** @type {{id:string, blob:Blob, ord:number, bitmap:ImageBitmap, tex:THREE.Texture, aspect:number, url:string}[]} */
let images = [];

async function decode(blob) {
  // three ignores texture.flipY for ImageBitmap sources, so pre-flip the bitmap
  // itself and disable three's flip — otherwise every photo uploads upside down.
  const bmp = await createImageBitmap(blob, { imageOrientation: 'flipY' });
  const tex = new THREE.Texture(bmp);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return { bmp, tex, aspect: bmp.width / bmp.height };
}

const MAX_SIDE = 760;
async function shrink(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 900_000) { bmp.close(); return file; }
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const png = file.type === 'image/png';
  return await new Promise(r => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.88));
}

async function addFiles(files) {
  const list = [...files].filter(f => f.type.startsWith('image/'));
  if (!list.length) return;
  toast(`Adding ${list.length} image${list.length > 1 ? 's' : ''}…`);
  let ord = images.length ? Math.max(...images.map(i => i.ord)) + 1 : 0;
  for (const f of list) {
    try {
      const blob = await shrink(f);
      const rec = { id: uid(), blob, ord: ord++ };
      await idbPut(rec);
      const { bmp, tex, aspect } = await decode(blob);
      images.push({ ...rec, bitmap: bmp, tex, aspect, url: URL.createObjectURL(blob) });
    } catch (e) { console.warn('skip', f.name, e); }
  }
  images.sort((a, b) => a.ord - b.ord);
  renderThumbs(); rebuildLayout(); toast(`${images.length} images`);
}

/* drop the meshes that use these textures before releasing them — a frame drawn
   against a closed ImageBitmap uploads a zero-sized texture */
function release(list) {
  for (const im of list) { URL.revokeObjectURL(im.url); im.tex.dispose(); im.bitmap.close?.(); }
}

async function removeImage(id) {
  const i = images.findIndex(x => x.id === id);
  if (i < 0) return;
  const [gone] = images.splice(i, 1);
  rebuildLayout();
  release([gone]);
  await idbDel(id);
  if (!images.length) await demoSet(); else renderThumbs();
}

async function clearImages() {
  const old = images;
  images = [];
  rebuildLayout();
  release(old);
  await idbClear();
  renderThumbs();
}

/* procedural demo tiles — stand-in product shots on near-white paper */
const DEMO = [
  { r: [4, 5], bg: '#f7f6f3', ink: '#3b4a6b', k: 'chair' },
  { r: [1, 1], bg: '#f4f3f0', ink: '#8d8781', k: 'disc' },
  { r: [5, 4], bg: '#f6f5f2', ink: '#5a4f47', k: 'blob' },
  { r: [3, 4], bg: '#f2f1ed', ink: '#2b2b2b', k: 'cans' },
  { r: [4, 3], bg: '#f8f7f5', ink: '#a9a49d', k: 'room' },
  { r: [1, 1], bg: '#f5f4f1', ink: '#c8901f', k: 'disc' },
  { r: [4, 5], bg: '#f6f5f3', ink: '#9aa3a6', k: 'lamp' },
  { r: [16, 10], bg: '#f3f2ef', ink: '#b8b2a8', k: 'room' },
  { r: [1, 1], bg: '#f7f6f4', ink: '#6f6a64', k: 'cans' },
  { r: [4, 5], bg: '#f4f3f1', ink: '#b06a4a', k: 'blob' },
  { r: [5, 4], bg: '#f7f7f5', ink: '#3f4542', k: 'lamp' },
  { r: [3, 4], bg: '#f5f4f0', ink: '#8a8f93', k: 'chair' },
  { r: [1, 1], bg: '#f6f5f2', ink: '#54595c', k: 'disc' },
  { r: [4, 3], bg: '#f8f7f4', ink: '#c3bdb2', k: 'room' },
  { r: [4, 5], bg: '#f4f3ef', ink: '#7d6b5a', k: 'cans' },
  { r: [1, 1], bg: '#f6f6f4', ink: '#2f3a52', k: 'blob' },
  { r: [5, 4], bg: '#f5f5f2', ink: '#9c9186', k: 'lamp' },
  { r: [3, 4], bg: '#f7f6f3', ink: '#454b4e', k: 'chair' }
];

function demoBlob(i) {
  const d = DEMO[i % DEMO.length];
  const c = document.createElement('canvas');
  c.width = d.r[0] * 80; c.height = d.r[1] * 80;
  const g = c.getContext('2d'), W = c.width, H = c.height;

  g.fillStyle = d.bg; g.fillRect(0, 0, W, H);
  const wash = g.createLinearGradient(0, 0, 0, H);
  wash.addColorStop(0, 'rgba(255,255,255,0.35)');
  wash.addColorStop(1, 'rgba(0,0,0,0.012)');
  g.fillStyle = wash; g.fillRect(0, 0, W, H);

  const cx = W / 2, cy = H * 0.54, s = Math.min(W, H) * 0.24;
  g.fillStyle = d.ink;

  if (d.k === 'disc') {
    g.beginPath(); g.arc(cx, cy, s * 1.25, 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.arc(cx, cy, s * 0.24, 0, Math.PI * 2); g.fill();
    g.globalCompositeOperation = 'source-over';
  } else if (d.k === 'chair') {
    g.beginPath(); g.roundRect(cx - s, cy - s * 0.9, s * 2, s * 1.5, s * 0.3); g.fill();
    g.beginPath(); g.roundRect(cx - s * 1.15, cy - s * 1.5, s * 0.45, s * 1.9, s * 0.22); g.fill();
    g.beginPath(); g.roundRect(cx + s * 0.7, cy - s * 1.5, s * 0.45, s * 1.9, s * 0.22); g.fill();
  } else if (d.k === 'blob') {
    g.beginPath();
    g.moveTo(cx - s * 1.5, cy + s * 0.5);
    g.bezierCurveTo(cx - s * 1.7, cy - s, cx - s * 0.2, cy - s * 1.3, cx + s * 0.4, cy - s * 0.5);
    g.bezierCurveTo(cx + s * 1.1, cy + s * 0.2, cx + s * 1.8, cy + s * 0.1, cx + s * 1.5, cy + s * 0.6);
    g.bezierCurveTo(cx + s, cy + s * 1.1, cx - s, cy + s, cx - s * 1.5, cy + s * 0.5);
    g.fill();
  } else if (d.k === 'cans') {
    g.beginPath(); g.roundRect(cx - s * 1.05, cy - s, s * 0.85, s * 2, s * 0.24); g.fill();
    g.beginPath(); g.roundRect(cx + s * 0.2, cy - s * 0.6, s * 0.85, s * 1.6, s * 0.24); g.fill();
  } else if (d.k === 'lamp') {
    g.beginPath(); g.moveTo(cx, cy - s * 1.3); g.lineTo(cx + s * 1.1, cy + s * 0.2);
    g.lineTo(cx - s * 1.1, cy + s * 0.2); g.closePath(); g.fill();
    g.fillRect(cx - s * 0.06, cy - s * 2.1, s * 0.12, s * 0.85);
  } else {
    g.globalAlpha = 0.5; g.fillRect(0, H * 0.62, W, H * 0.38); g.globalAlpha = 1;
    g.fillRect(W * 0.12, H * 0.3, W * 0.16, H * 0.34);
    g.fillRect(W * 0.62, H * 0.22, W * 0.24, H * 0.42);
  }

  if (d.k !== 'room') {
    g.globalAlpha = 0.10; g.fillStyle = '#000';
    g.beginPath(); g.ellipse(cx, cy + s * 1.35, s * 1.35, s * 0.15, 0, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
  }
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
}

async function demoSet() {
  await clearImages();
  for (let i = 0; i < DEMO.length; i++) {
    const blob = await demoBlob(i);
    const rec = { id: uid(), blob, ord: i };
    await idbPut(rec);
    const { bmp, tex, aspect } = await decode(blob);
    images.push({ ...rec, bitmap: bmp, tex, aspect, url: URL.createObjectURL(blob) });
  }
  renderThumbs(); rebuildLayout();
}

/* ───────────────────────── layout ─────────────────────────── */

/** @type {{mesh:THREE.Mesh, u:number, flat:THREE.Vector3, fw:number, fh:number,
 *          dir:THREE.Vector3, q:THREE.Quaternion, sw:number, sh:number,
 *          delay:number}[]} */
let tiles = [];
const tileGroup = new THREE.Group();
scene.add(tileGroup);
let R = 1, gridW = 1, gridH = 1;

/** keep x inside the wrapped sheet, so a row shift is a cyclic rotation */
function wrapX(x, w) { return ((x + w / 2) % w + w) % w - w / 2; }

/* Deal images out like a shuffled deck rather than cycling 0,1,2,…,0,1,2,…
   Straight cycling repeats with period `images.length`; whenever a row holds a
   multiple of that (or shares a factor with it) every row starts on the same
   image and the grid grows vertical stripes of identical tiles. Dealing from a
   reshuffled bag keeps usage even but breaks the period. Seeded, so the layout
   is identical on every rebuild. */
function mulberry32(a) {
  return () => {
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function dealer(n, seed = 0x9E3779B9) {
  const rnd = mulberry32(seed);
  let bag = [], last = -1;
  return () => {
    if (!bag.length) {
      bag = [...Array(n).keys()];
      for (let i = bag.length - 1; i > 0; i--) {          // Fisher–Yates
        const j = Math.floor(rnd() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      // don't let a refill repeat the tile we just dealt
      if (n > 1 && bag[bag.length - 1] === last) {
        [bag[bag.length - 1], bag[0]] = [bag[0], bag[bag.length - 1]];
      }
    }
    return (last = bag.pop());
  };
}

function disposeTiles() {
  tiles.forEach(t => { t.mesh.material.dispose(); tileGroup.remove(t.mesh); });
  tiles = [];
}

function rebuildLayout() {
  disposeTiles();
  if (!images.length || !view.vw) return;

  gridW = view.vw * S.spread;
  // portrait has height to spare — let the globe run wider there
  const portrait = view.vw < view.vh ? 1.32 : 1;
  R = S.globeSize * Math.min(view.vw, view.vh) * 0.5 * portrait;

  // how many tiles read across the viewport — denser on wide screens
  if (S.colsAuto) {
    S.cols = THREE.MathUtils.clamp(Math.round(2.2 + 4.2 * (view.vw / view.vh)), 4, 11);
    const el = document.getElementById('cols');
    if (el && document.activeElement !== el) el.value = S.cols;
  }

  const aspects = images.map(im => THREE.MathUtils.lerp(im.aspect, 1, S.crop));
  const avgA = aspects.reduce((a, b) => a + b, 0) / aspects.length;
  const cell = view.vw / S.cols;          // Columns = tiles visible across the viewport
  const targetH = cell / avgA;
  const gapW = S.gap * cell;

  // enough rows to both fill the viewport and wrap as a 2:1 sphere sheet
  if (S.rowsAuto) {
    const sheet = (gridW / 2) / (targetH + gapW);
    const fill = (view.vh + targetH) / (targetH + gapW);
    S.rows = THREE.MathUtils.clamp(Math.round(Math.max(sheet, fill)), 2, 40);
    const el = document.getElementById('rows');
    if (el && document.activeElement !== el) el.value = S.rows;
  }

  // justified rows, every row exactly gridW wide, images dealt out to fill
  const rows = [];
  const deal = dealer(images.length);
  let row = [], sumA = 0;
  let guard = 0;
  while (rows.length < S.rows && guard++ < 20000) {
    const idx = deal();
    const a = aspects[idx];
    row.push(idx); sumA += a;
    const h = (gridW - gapW * (row.length - 1)) / sumA;
    if (h <= targetH || row.length >= S.cols * S.spread * 2 + 4) {
      rows.push({ idx: row, h }); row = []; sumA = 0;
    }
  }

  gridH = rows.reduce((s, r) => s + r.h, 0) + gapW * (rows.length - 1);

  // isometric wrap scale, limited by whichever axis binds
  const scaleH = (2 * Math.PI * R) / gridW;
  const scaleV = (Math.PI * 0.98 * R) / gridH;
  // never overrun the equator; when the sheet is too tall, split the difference
  // so tiles overlap a little vertically rather than leaving the globe bare
  const sc = S.tileScale * Math.min(scaleH, Math.sqrt(scaleH * scaleV));
  const latSpan = Math.min((gridH * sc) / R, Math.PI * 0.98);

  let y = gridH / 2, rowN = 0;
  for (const r of rows) {
    const cy = y - r.h / 2;
    // running bond: shift alternate rows so tile edges never line up into columns.
    // the row spans the full wrap, so shifting is a cyclic rotation — no gap opens up
    const shift = (rowN % 2 ? 1 : 0) * S.offset * cell;
    rowN++;

    // A row at latitude lat is only cos(lat) as long as the equator, so carrying a
    // full row's worth of tiles up there piles them into a crown at the pole. Drop
    // that fraction of them, evenly decimated. Culled tiles stay in the flat grid
    // and fade out as it wraps.
    const rowLat = THREE.MathUtils.clamp((cy / gridH) * latSpan, -1.53, 1.53);
    const n = r.idx.length;
    const keep = THREE.MathUtils.clamp(Math.round(n * Math.max(Math.cos(rowLat), 0)), 1, n);
    const onRow = r.idx.map((_, j) => Math.floor((j + 1) * keep / n) > Math.floor(j * keep / n));

    // Then re-justify the survivors around the ring. Leaving them at the longitudes
    // they had in the grid is what tore holes in the globe: tiles differ in width and
    // the decimation skips uneven numbers of them, so the slots came out uneven while
    // the tiles did not. Giving each one an angular share proportional to its width
    // makes every ring close on itself exactly, at any latitude.
    const advOf = i => aspects[r.idx[i]] * r.h + gapW;
    let ringAdv = 0;
    r.idx.forEach((_, i) => { if (onRow[i]) ringAdv += advOf(i); });
    const lonStart = -Math.PI + (shift / gridW) * Math.PI * 2;
    let ringAng = 0;

    let x = -gridW / 2;
    for (let j = 0; j < r.idx.length; j++) {
      const idx = r.idx[j];
      const im = images[idx];
      const aspect = aspects[idx];
      const fw = aspect * r.h, fh = r.h;
      const cx = wrapX(x + fw / 2 + shift, gridW);
      x += fw + gapW;

      const onSphere = onRow[j];
      const u = cx / gridW;                 // −0.5 … 0.5
      const lat = rowLat;

      let lon;
      if (onSphere) {
        const span = (Math.PI * 2) * advOf(j) / ringAdv;
        lon = lonStart + ringAng + span / 2;
        ringAng += span;
      } else {
        lon = lonStart + ringAng;           // fading out; ride the nearest gap
      }

      const dir = new THREE.Vector3(
        Math.cos(lat) * Math.sin(lon),
        Math.sin(lat),
        Math.cos(lat) * Math.cos(lon)
      );

      // lie flat on the surface, facing outward
      const q = new THREE.Quaternion();
      const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
      if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
      const up = new THREE.Vector3().crossVectors(dir, right).normalize();
      q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, dir));

      const taper = THREE.MathUtils.lerp(1, Math.max(Math.cos(lat), 0.05), S.taper);

      const mat = makeMaterial(im.tex, aspect, { side: S.backs ? THREE.DoubleSide : THREE.FrontSide });
      applyCover(mat, im.aspect, aspect);
      mat.uniforms.uRadius.value = S.radius;
      const mesh = new THREE.Mesh(GEO, mat);
      mesh.frustumCulled = false;
      tileGroup.add(mesh);

      tiles.push({
        mesh, u,
        flat: new THREE.Vector3(cx, cy, 0), fw, fh,
        dir, q, sw: fw * sc * taper, sh: fh * sc * taper,
        delay: (0.5 - Math.abs(u)) * 2, onSphere, row: rowN - 1
      });
    }
    y -= r.h + gapW;
  }

  buildText();
}

function applyCover(mat, imgAspect, targetAspect) {
  const rep = mat.uniforms.uRep.value, off = mat.uniforms.uOff.value;
  if (imgAspect > targetAspect) {
    rep.set(targetAspect / imgAspect, 1);
    off.set((1 - rep.x) / 2, 0);
  } else {
    rep.set(1, imgAspect / targetAspect);
    off.set(0, (1 - rep.y) / 2);
  }
}

/* ───────────────────────── word on the sphere ─────────────── */

let letters = [];
const textGroup = new THREE.Group();
scene.add(textGroup);

function letterTexture(ch, color) {
  const FS = 110, pad = 4;
  const m = document.createElement('canvas').getContext('2d');
  m.font = `500 ${FS}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  const w = Math.ceil(m.measureText(ch).width) + pad * 2;
  const h = Math.round(FS * 1.34);
  const c = document.createElement('canvas');
  c.width = Math.max(w, 4); c.height = h;
  const g = c.getContext('2d');
  g.font = m.font; g.fillStyle = color;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(ch, c.width / 2, c.height / 2 + FS * 0.03);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.needsUpdate = true;
  return { tex, aspect: c.width / c.height };
}

function buildText() {
  letters.forEach(l => { l.mesh.material.uniforms.uMap.value.dispose(); l.mesh.material.dispose(); textGroup.remove(l.mesh); });
  letters = [];
  const word = (S.word || '').toUpperCase();
  if (!word.trim() || !R) return;

  const H = S.textSize * R * 1.34;
  const lat = S.textLat * (Math.PI / 2) * 0.85;
  const ring = Math.max(R * Math.cos(lat), 1e-3);

  const glyphs = [...word].map(ch => {
    if (ch === ' ') return { space: true, w: H * 0.42 };
    const { tex, aspect } = letterTexture(ch, S.textColor);
    return { tex, aspect, w: H * aspect };
  });

  const track = H * 0.10 * (S.textTrack * 2 - 1.6);
  const total = glyphs.reduce((s, g) => s + g.w, 0) + track * (glyphs.length - 1);
  let x = -total / 2;

  for (const g of glyphs) {
    const cx = x + g.w / 2;
    x += g.w + track;
    if (g.space) continue;
    const lon = cx / ring;
    const dir = new THREE.Vector3(
      Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)
    );
    const q = new THREE.Quaternion();
    const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(dir, right).normalize();
    q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, dir));

    const mat = makeMaterial(g.tex, g.aspect, { side: THREE.FrontSide, depthWrite: false });
    const mesh = new THREE.Mesh(GEO, mat);
    mesh.scale.set(H * g.aspect, H, 1);
    mesh.renderOrder = 2;
    mesh.frustumCulled = false;
    textGroup.add(mesh);
    letters.push({ mesh, dir, q });
  }
}

/* ───────────────────────── morph + spin ───────────────────── */

let p = 0, target = 0;            // 0 = grid, 1 = globe
let pFrom = 0, tStart = performance.now(), pSpan = 1;
let yaw = 0, pitch = 0, vYaw = 0, vPitch = 0, dragging = false;
let loopTimer = 0;
let scrollAcc = 0;               // endless horizontal drift of the flat grid

const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const smooth = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _qs = new THREE.Quaternion(), _q = new THREE.Quaternion(), _qi = new THREE.Quaternion();
const _e = new THREE.Euler();

let last = performance.now();
function frame(now) {
  const dt = Math.min((now - last) / 1000, 0.05); last = now;

  // morph — driven by wall clock so dropped frames never stall it
  const k = THREE.MathUtils.clamp((now - tStart) / 1000 / (Math.max(S.dur, 0.05) * pSpan), 0, 1);
  p = pFrom + (target - pFrom) * k;

  // auto loop
  if (S.loop && !dragging) {
    if (k === 1) {
      loopTimer += dt;
      if (loopTimer > S.dwell) { loopTimer = 0; setTarget(target ? 0 : 1); }
    } else loopTimer = 0;
  }

  // spin + inertia
  if (!dragging) { yaw += vYaw * dt; pitch += vPitch * dt; vYaw *= 0.94; vPitch *= 0.94; }
  yaw += S.spin * dt * p;
  pitch = THREE.MathUtils.clamp(pitch, -1.1, 1.1);
  _e.set(pitch + S.tilt * p, yaw, 0, 'XYZ');
  _qs.setFromEuler(_e);

  // rows drift sideways in alternating directions, endlessly — the flat sheet is
  // periodic across gridW, so wrapX turns the slide into a seamless cyclic loop.
  // Fades out with the wrap (×(1−p)) so it never disturbs the sphere mapping.
  scrollAcc += dt * S.drift * gridW;
  const drift = scrollAcc * (1 - p);

  const span = 1 + S.stagger;
  for (const t of tiles) {
    const e = ease(THREE.MathUtils.clamp(p * span - t.delay * S.stagger, 0, 1));
    const m = t.mesh;

    const fx = wrapX(t.flat.x + (t.row & 1 ? -drift : drift), gridW);

    _v.copy(t.dir).applyQuaternion(_qs);                    // world normal
    _v2.copy(_v).multiplyScalar(R * (1 + Math.sin(Math.PI * e) * S.bulge));
    m.position.set(
      THREE.MathUtils.lerp(fx, _v2.x, e),
      THREE.MathUtils.lerp(t.flat.y, _v2.y, e),
      THREE.MathUtils.lerp(t.flat.z, _v2.z, e)
    );

    _q.copy(_qs).multiply(t.q);
    m.quaternion.copy(_qi.identity()).slerp(_q, e);

    m.scale.set(
      THREE.MathUtils.lerp(t.fw, t.sw, e),
      THREE.MathUtils.lerp(t.fh, t.sh, e),
      1
    );
    m.material.uniforms.uRadius.value = S.radius;

    // tiles the polar rows can't fit belong to the grid only
    const op = t.onSphere ? 1 : 1 - e;
    m.material.uniforms.uOpacity.value = op;
    m.visible = op > 0.01;
  }

  const tOp = smooth(0.55, 0.98, p);
  for (const l of letters) {
    _v.copy(l.dir).applyQuaternion(_qs).multiplyScalar(R * S.textLift);
    l.mesh.position.copy(_v);
    l.mesh.quaternion.copy(_qs).multiply(l.q);
    l.mesh.material.uniforms.uOpacity.value = tOp;
    l.mesh.visible = tOp > 0.01;
  }

  brand.style.color = `rgba(163,160,154,${1 - p})`;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function setTarget(v) {
  pFrom = p; target = v; loopTimer = 0;
  pSpan = Math.max(Math.abs(v - pFrom), 0.001);
  tStart = performance.now();
  playLabel.textContent = v ? 'Unwrap' : 'Wrap';
  playIcon.innerHTML = v
    ? '<path d="M4 6h7v7H4zM13 11h7v7h-7z"/>'
    : '<path d="M8 5.5l11 6.5-11 6.5z"/>';
}

/* ───────────────────────── interaction ────────────────────── */

let px = 0, py = 0, pid = null, moved = 0;
renderer.domElement.addEventListener('pointerdown', e => {
  pid = e.pointerId; dragging = true; moved = 0;
  px = e.clientX; py = e.clientY; vYaw = vPitch = 0;
  try { renderer.domElement.setPointerCapture(pid); } catch { /* pointer already gone */ }
});
renderer.domElement.addEventListener('pointermove', e => {
  if (!dragging || e.pointerId !== pid) return;
  const dx = e.clientX - px, dy = e.clientY - py;
  px = e.clientX; py = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
  const k = 0.007;
  yaw += dx * k; pitch += dy * k;
  vYaw = dx * k / 0.016; vPitch = dy * k / 0.016;
});
const endDrag = e => {
  if (e.pointerId !== pid) return;
  dragging = false; pid = null;
  vYaw = THREE.MathUtils.clamp(vYaw, -6, 6);
  vPitch = THREE.MathUtils.clamp(vPitch, -6, 6);
};
renderer.domElement.addEventListener('pointerup', endDrag);
renderer.domElement.addEventListener('pointercancel', endDrag);

addEventListener('keydown', e => {
  const t = e.target;
  if (t instanceof Element && t.matches('input, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); setTarget(target ? 0 : 1); }
  else if (e.key === 's' || e.key === 'S') panel.toggleAttribute('hidden-state');
  else if (e.key === 'Escape') panel.setAttribute('hidden-state', '');
});

/* ───────────────────────── UI ─────────────────────────────── */

const $ = s => document.querySelector(s);
const brand = $('#brand'), playLabel = $('#playLabel'), playIcon = $('#playIcon');
const panel = $('#panel'), thumbs = $('#thumbs'), fileInput = $('#file'), veil = $('#veil');

$('#playBtn').onclick = () => setTarget(target ? 0 : 1);
$('#gearBtn').onclick = () => panel.toggleAttribute('hidden-state');
$('#closeBtn').onclick = () => panel.setAttribute('hidden-state', '');
$('#addBtn').onclick = () => fileInput.click();
$('#drop').onclick = () => fileInput.click();
fileInput.onchange = () => { addFiles(fileInput.files); fileInput.value = ''; };
$('#demoBtn').onclick = () => demoSet();
$('#clearBtn').onclick = () => clearImages();
$('#resetBtn').onclick = () => {
  Object.assign(S, DEFAULTS);
  localStorage.removeItem('globe.settings');
  syncUI(); applyBg(); rebuildLayout();
};

document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('.pane').forEach(p2 => p2.classList.toggle('on', p2.dataset.pane === tab.dataset.pane));
  };
});

/* drag & drop anywhere */
let dragDepth = 0;
addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) veil.classList.add('on'); });
addEventListener('dragover', e => e.preventDefault());
addEventListener('dragleave', e => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; veil.classList.remove('on'); } });
addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; veil.classList.remove('on');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});

/* sliders built from markup */
const sliders = {};
document.querySelectorAll('[data-slider]').forEach(host => {
  const key = host.dataset.slider;
  const el = document.createElement('div');
  el.className = 'ctrl';
  el.innerHTML = `<span>${host.dataset.label}</span><b></b>
    <input type="range" min="${host.dataset.min}" max="${host.dataset.max}" step="${host.dataset.step}">`;
  host.replaceWith(el);
  const input = el.querySelector('input'), out = el.querySelector('b');
  const fmt = host.dataset.fmt;
  const paint = () => {
    const v = +input.value, min = +input.min, max = +input.max;
    el.style.setProperty('--fill', ((v - min) / (max - min) * 100) + '%');
    out.textContent = fmt === '%' ? Math.round(v * 100)
      : fmt === 's' ? v.toFixed(2) + 's'
        : v.toFixed(2);
  };
  input.oninput = () => { S[key] = +input.value; paint(); onChange(key); };
  sliders[key] = { input, paint };
});

const numbers = ['cols', 'rows'];
numbers.forEach(k => {
  const el = document.getElementById(k);
  el.oninput = () => {
    const v = parseInt(el.value, 10);
    if (!Number.isFinite(v)) return;
    S[k] = THREE.MathUtils.clamp(v, +el.min, +el.max);
    if (k === 'rows') S.rowsAuto = false;
    if (k === 'cols') S.colsAuto = false;
    onChange(k);
  };
});

$('#loop').onchange = e => { S.loop = e.target.checked; save(); };
$('#backs').onchange = e => {
  S.backs = e.target.checked; save();
  const side = S.backs ? THREE.DoubleSide : THREE.FrontSide;
  tiles.forEach(t => { t.mesh.material.side = side; t.mesh.material.needsUpdate = true; });
};
$('#word').oninput = e => { S.word = e.target.value; save(); buildText(); };

function bindColor(pickId, hexId, key, after) {
  const pick = document.getElementById(pickId), hex = document.getElementById(hexId);
  const set = v => {
    if (!/^#[0-9a-f]{6}$/i.test(v)) { hex.value = S[key]; return; }
    S[key] = v; pick.value = v; hex.value = v;
    pick.parentElement.style.background = v;
    save(); after();
  };
  pick.oninput = () => set(pick.value);
  hex.onchange = () => set(hex.value.trim());
  return () => { pick.value = S[key]; hex.value = S[key]; pick.parentElement.style.background = S[key]; };
}
const syncColors = [
  bindColor('textColor', 'textHex', 'textColor', () => buildText()),
  bindColor('bgColor', 'bgHex', 'bgColor', () => applyBg())
];

function applyBg() {
  renderer.setClearColor(new THREE.Color(S.bgColor), 1);
  frameEl.style.background = S.bgColor;
}

const REBUILD = new Set(['cols', 'rows', 'gap', 'spread', 'offset', 'crop', 'globeSize', 'tileScale', 'taper',
  'textSize', 'textTrack', 'textLat']);
function onChange(key) {
  save();
  if (REBUILD.has(key)) rebuildLayout();
}

function syncUI() {
  for (const [k, s] of Object.entries(sliders)) { s.input.value = S[k]; s.paint(); }
  numbers.forEach(k => document.getElementById(k).value = S[k]);
  $('#loop').checked = S.loop;
  $('#backs').checked = S.backs;
  $('#word').value = S.word;
  syncColors.forEach(fn => fn());
}

function renderThumbs() {
  thumbs.innerHTML = '';
  for (const im of images) {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.innerHTML = `<img src="${im.url}" alt="">
      <button aria-label="Remove"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`;
    d.querySelector('button').onclick = () => removeImage(im.id);
    thumbs.appendChild(d);
  }
  $('#count').textContent = images.length
    ? `${images.length} image${images.length > 1 ? 's' : ''} · dealt across ${S.rows} rows`
    : 'No images yet';
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 1800);
}

/* ───────────────────────── boot ───────────────────────────── */

(async function boot() {
  syncUI(); applyBg(); setTarget(0);
  resize();
  requestAnimationFrame(frame);
  const recs = (await idbAll() || []).sort((a, b) => a.ord - b.ord);
  if (!recs.length) { await demoSet(); return; }   // first visit, or no store

  for (const r of recs) {
    try {
      const { bmp, tex, aspect } = await decode(r.blob);
      images.push({ ...r, bitmap: bmp, tex, aspect, url: URL.createObjectURL(r.blob) });
    } catch (e) { console.warn('could not decode a stored image', e); }
  }
  if (!images.length) { await demoSet(); return; }
  renderThumbs(); rebuildLayout();
})();

