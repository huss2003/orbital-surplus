// three/jacket.js — procedural stand-ins for the original GLB jackets.
//
// Two variants built from lathe / cylinder / tube / extrude primitives:
//   "moto"   — cropped torso, asymmetric diagonal zip, notched lapels, belt, zipped cuffs
//   "bomber" — longer torso, hex-embossed leather (canvas normal map), ribbed collar,
//              cuffs and hem (canvas rib normal map), centre zip, flap pockets, sleeve stripes
// Black glossy PBR (MeshPhysicalMaterial + clearcoat) so RoomEnvironment reflections read
// like the original HDR-lit leather. Geometry is merged per material (≈4 draw calls per
// jacket, ~5k triangles) because the shop draws 35 of them.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const ZS = 0.58;                  // torso depth squash (elliptical cross-section)
const ARM_DROP = THREE.MathUtils.degToRad(38);
const SLEEVE_L = 1.05;

const PROFILES = {
  // [radius, y] from hem to neck
  moto: [[0.47, -0.5], [0.455, -0.3], [0.47, -0.05], [0.52, 0.2], [0.53, 0.36], [0.46, 0.5], [0.3, 0.6], [0.19, 0.66]],
  bomber: [[0.47, -0.6], [0.5, -0.4], [0.51, -0.1], [0.53, 0.2], [0.54, 0.36], [0.47, 0.5], [0.31, 0.6], [0.2, 0.66]],
  shell: [[0.5, -0.72], [0.5, -0.45], [0.51, -0.1], [0.53, 0.2], [0.54, 0.36], [0.47, 0.5], [0.3, 0.6], [0.2, 0.66]],
  field: [[0.52, -0.74], [0.52, -0.45], [0.52, -0.1], [0.54, 0.2], [0.55, 0.36], [0.48, 0.5], [0.31, 0.6], [0.2, 0.66]],
  coach: [[0.5, -0.58], [0.51, -0.35], [0.52, -0.05], [0.54, 0.2], [0.55, 0.36], [0.48, 0.5], [0.31, 0.6], [0.2, 0.66]],
};
// Reentry Puffer: the bomber silhouette, inflated, with a sine bulge per baffle (quilted channels)
PROFILES.puffer = (() => {
  const out = [], base = [[0.56, -0.62], [0.58, -0.3], [0.6, 0.1], [0.6, 0.32], [0.52, 0.5], [0.34, 0.6], [0.22, 0.67]];
  const n = 72;
  for (let i = 0; i <= n; i++) {
    const y = -0.62 + (1.29 * i) / n;
    const bulge = y < 0.46 ? 0.028 * Math.abs(Math.sin(((y + 0.62) / 0.18) * Math.PI)) : 0;
    out.push([radiusAt(base, y) + bulge, y]);
  }
  return out;
})();

// Per-variant look: colour, finish, accent. One place to tune the whole line-up.
const LOOKS = {
  moto:   { color: 0x0b0b0b, rough: 0.27, coat: 1,    accent: 0xe6e6e6 },
  bomber: { color: 0x0b0b0b, rough: 0.34, coat: 1,    accent: 0xe6e6e6, hex: true },
  puffer: { color: 0xd4561c, rough: 0.5,  coat: 0.35, accent: 0x1a1a1a },
  shell:  { color: 0x5b646c, rough: 0.4, coat: 0.5,  accent: 0xc8ff2e },
  field:  { color: 0x3d4430, rough: 0.86, coat: 0,    accent: 0x2a2f22 },
  coach:  { color: 0x161d2c, rough: 0.48, coat: 0.25, accent: 0xc8ff2e },
};
export const VARIANTS = Object.keys(LOOKS);
const SLEEVE = [[0.2, 0], [0.19, -0.2], [0.165, -0.6], [0.14, -SLEEVE_L]];
const SLEEVE_ASC = SLEEVE.slice().reverse();          // ascending y for radiusAt / LatheGeometry
function sleeveProfile(variant) {
  if (variant !== 'puffer') return SLEEVE_ASC;
  const out = [];
  for (let i = 0; i <= 40; i++) {
    const y = -SLEEVE_L + (SLEEVE_L * i) / 40;
    out.push([radiusAt(SLEEVE_ASC, y) * 1.22 + 0.022 * Math.abs(Math.sin((y / 0.16) * Math.PI)), y]);
  }
  return out;
}

function radiusAt(profile, y) {
  if (y <= profile[0][1]) return profile[0][0];
  for (let i = 1; i < profile.length; i++) {
    const [r1, y1] = profile[i], [r0, y0] = profile[i - 1];
    if (y <= y1) return r0 + (r1 - r0) * ((y - y0) / (y1 - y0));
  }
  return profile[profile.length - 1][0];
}
const surfZ = (profile, x, y, lift = 0.008) => ZS * Math.sqrt(Math.max(radiusAt(profile, y) ** 2 - x * x, 0)) + lift;

// ------------------------------------------------------------ canvas normal maps
function heightToNormal(ctx, w, h, strength) {
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = ctx.createImageData(w, h);
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength;
    let nx = -dx, ny = dy, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * w + x) * 4;
    out.data[i] = (nx * 0.5 + 0.5) * 255; out.data[i + 1] = (ny * 0.5 + 0.5) * 255; out.data[i + 2] = (nz * 0.5 + 0.5) * 255; out.data[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}
let hexTex = null, ribTex = null;
/** Hexagonal embossed leather (Retro Forge). Tileable: width = 4·√3·s, height = 6·s. */
export function hexNormalMap() {
  if (hexTex) return hexTex;
  const s = 22, w = Math.round(4 * Math.sqrt(3) * s), h = 6 * s;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#c8c8c8'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 4; ctx.filter = 'blur(1.5px)';
  const hw = Math.sqrt(3) * s;
  for (let row = -1; row <= 4; row++) for (let col = -1; col <= 5; col++) {
    const cx = col * hw + (row % 2 ? hw / 2 : 0), cy = row * 1.5 * s;
    ctx.beginPath();
    for (let k = 0; k < 6; k++) { const a = Math.PI / 6 + (k * Math.PI) / 3; ctx[k ? 'lineTo' : 'moveTo'](cx + s * Math.cos(a), cy + s * Math.sin(a)); }
    ctx.closePath(); ctx.stroke();
  }
  ctx.filter = 'none';
  heightToNormal(ctx, w, h, 3);
  hexTex = new THREE.CanvasTexture(c);
  hexTex.wrapS = hexTex.wrapT = THREE.RepeatWrapping; hexTex.repeat.set(7, 3); hexTex.colorSpace = THREE.NoColorSpace;
  return hexTex;
}
/** Vertical ribbing for knit collar / cuffs / hem. */
export function ribNormalMap() {
  if (ribTex) return ribTex;
  const w = 64, h = 4, c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  for (let x = 0; x < w; x++) { const v = 128 + 127 * Math.sin((x / w) * Math.PI * 2 * 4); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(x, 0, 1, h); }
  heightToNormal(ctx, w, h, 4);
  ribTex = new THREE.CanvasTexture(c);
  ribTex.wrapS = ribTex.wrapT = THREE.RepeatWrapping; ribTex.repeat.set(10, 1); ribTex.colorSpace = THREE.NoColorSpace;
  return ribTex;
}

// ------------------------------------------------------------ materials
function makeMaterials(variant) {
  const L = LOOKS[variant] || LOOKS.moto;
  const leather = new THREE.MeshPhysicalMaterial({
    color: L.color, roughness: L.rough, metalness: 0,
    clearcoat: L.coat, clearcoatRoughness: 0.12 + (1 - L.coat) * 0.4, side: THREE.DoubleSide,
  });
  if (L.hex) { leather.normalMap = hexNormalMap(); leather.normalScale.set(0.7, 0.7); }
  const ribColor = new THREE.Color(L.color).multiplyScalar(0.8);
  return {
    leather,
    rib: new THREE.MeshPhysicalMaterial({ color: ribColor, roughness: 0.75, metalness: 0, normalMap: ribNormalMap(), side: THREE.DoubleSide }),
    metal: new THREE.MeshStandardMaterial({ color: 0xbdbdbd, metalness: 1, roughness: 0.28 }),
    accent: new THREE.MeshStandardMaterial({ color: L.accent, roughness: 0.5, metalness: 0, side: THREE.DoubleSide, emissive: L.accent === 0xc8ff2e ? 0x2a3a00 : 0x000000 }),
  };
}

// ------------------------------------------------------------ geometry helpers
const v2 = (pts) => pts.map(([r, y]) => new THREE.Vector2(r, y));
const tube = (pts, r = 0.012, seg = 32) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), seg, r, 6, false);
function sleeveMatrix(side) {
  // sleeve built hanging along -Y from the shoulder; rotate so -Y points out and 38° down
  const m = new THREE.Matrix4().makeRotationZ(side * (Math.PI / 2 - ARM_DROP));
  m.setPosition(side * 0.44, 0.38, 0);
  return m;
}
function sleeveSurface(y, angle = 0, lift = 0.006, prof = SLEEVE_ASC) {           // point on sleeve surface, local coords
  const r = radiusAt(prof, y) + lift;
  return new THREE.Vector3(Math.sin(angle) * r, y, Math.cos(angle) * r);
}

function buildParts(variant) {
  if (!LOOKS[variant]) variant = 'moto';
  const P = PROFILES[variant];
  const SP = sleeveProfile(variant);
  const parts = { leather: [], rib: [], metal: [], accent: [] };
  const add = (k, g) => parts[k].push(g);

  // torso (lathe, squashed in z)
  const torso = new THREE.LatheGeometry(v2(P), 40); torso.scale(1, 1, ZS); add('leather', torso);

  // sleeves (tapered lathe) + cuff details
  for (const side of [-1, 1]) {
    const M = sleeveMatrix(side);
    const sl = new THREE.LatheGeometry(v2(SP), variant === 'puffer' ? 24 : 20); sl.applyMatrix4(M); add('leather', sl);
    if (variant === 'bomber' || variant === 'puffer') {
      const cr = variant === 'puffer' ? 0.15 : 0.145;
      const cuff = new THREE.CylinderGeometry(cr, cr + 0.005, 0.12, 20, 1, true); cuff.translate(0, -SLEEVE_L + 0.03, 0); cuff.applyMatrix4(M); add('rib', cuff);
      if (variant === 'bomber') for (const y of [-0.22, -0.27, -0.32]) { const st = new THREE.CylinderGeometry(0.19, 0.19, 0.016, 20, 1, true); st.translate(0, y, 0); st.applyMatrix4(M); add('accent', st); }
    } else if (variant === 'shell') {
      // taped seam along the top of the sleeve + velcro cuff tab
      const pts = []; for (let i = 0; i <= 12; i++) pts.push(sleeveSurface(-(i / 12) * (SLEEVE_L - 0.02), Math.PI / 2, 0.004).applyMatrix4(M));
      add('accent', tube(pts, 0.007, 24));
      const tab = new THREE.BoxGeometry(0.05, 0.08, 0.014); tab.translate(0, -SLEEVE_L + 0.06, 0.15); tab.applyMatrix4(M); add('leather', tab);
    } else if (variant === 'field' || variant === 'coach') {
      const band = new THREE.CylinderGeometry(0.145, 0.145, 0.07, 20, 1, true); band.translate(0, -SLEEVE_L + 0.035, 0); band.applyMatrix4(M); add(variant === 'coach' ? 'rib' : 'leather', band);
      if (variant === 'field') { const pk = new THREE.BoxGeometry(0.11, 0.13, 0.02); pk.translate(0, -0.28, 0.19); pk.applyMatrix4(M); add('leather', pk); }
    }
    if (variant === 'moto') {
      const pts = []; for (let i = 0; i <= 8; i++) pts.push(sleeveSurface(-0.72 - (i / 8) * (SLEEVE_L - 0.74), 0.0).applyMatrix4(M));
      add('metal', tube(pts, 0.008, 16));
    }
  }

  if (variant === 'moto') {
    // stand collar + notched lapels
    const collar = new THREE.CylinderGeometry(0.2, 0.225, 0.1, 32, 1, true); collar.scale(1, 1, 0.8); collar.translate(0, 0.7, 0); add('leather', collar);
    for (const side of [-1, 1]) {
      const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.lineTo(0.19, 0.05); sh.lineTo(0.13, -0.05); sh.lineTo(0.16, -0.12); sh.lineTo(0.05, -0.3); sh.closePath();
      const lap = new THREE.ExtrudeGeometry(sh, { depth: 0.014, bevelEnabled: false });
      lap.rotateX(-0.42); lap.scale(side, 1, 1); lap.translate(side * 0.05, 0.6, surfZ(P, 0.12, 0.45, 0.01)); add('leather', lap);
    }
    // asymmetric zip from left hem up to the right lapel
    const zp = []; for (let i = 0; i <= 24; i++) { const t = i / 24, x = -0.13 + 0.3 * t * t * (3 - 2 * t), y = -0.49 + 0.9 * t; zp.push(new THREE.Vector3(x, y, surfZ(P, x, y))); }
    add('metal', tube(zp, 0.011, 48));
    // belt + buckle
    const belt = new THREE.CylinderGeometry(radiusAt(P, -0.46) + 0.012, radiusAt(P, -0.46) + 0.012, 0.075, 40, 1, true); belt.scale(1, 1, ZS); belt.translate(0, -0.455, 0); add('leather', belt);
    const buckle = new THREE.BoxGeometry(0.07, 0.085, 0.02); buckle.translate(0.3, -0.455, surfZ(P, 0.3, -0.455, 0.022)); buckle.rotateY(0); add('metal', buckle);
    // diagonal pocket zips
    for (const side of [-1, 1]) {
      const pp = []; for (let i = 0; i <= 6; i++) { const t = i / 6, x = side * (0.3 - 0.1 * t), y = -0.32 + 0.2 * t; pp.push(new THREE.Vector3(x, y, surfZ(P, x, y))); }
      add('metal', tube(pp, 0.007, 10));
    }
  } else if (variant === 'bomber' || variant === 'puffer') {
    // ribbed collar + hem, centre zip, welt + flap pockets
    const collar = new THREE.CylinderGeometry(0.205, 0.22, 0.12, 32, 1, true); collar.scale(1, 1, 0.8); collar.translate(0, 0.71, 0); add('rib', collar);
    const rh = radiusAt(P, -0.6);
    const hem = new THREE.CylinderGeometry(rh + 0.005, rh + 0.014, 0.14, 40, 1, true); hem.scale(1, 1, ZS); hem.translate(0, -0.63, 0); add('rib', hem);
    const zp = []; for (let i = 0; i <= 16; i++) { const y = -0.68 + (1.33 * i) / 16; zp.push(new THREE.Vector3(0, y, surfZ(P, 0, Math.min(y, 0.64)) + (y > 0.64 ? 0.04 : 0))); }
    add('metal', tube(zp, 0.012, 32));
    for (const side of [-1, 1]) {
      const x = side * 0.27, y = -0.3;
      const flap = new THREE.BoxGeometry(0.2, 0.055, 0.016);
      flap.rotateY(Math.atan2(x, surfZ(P, x, y) / ZS) * 0.75); flap.translate(x, y, surfZ(P, x, y, 0.012)); add('leather', flap);
    }
    if (variant === 'bomber') { const welt = new THREE.BoxGeometry(0.13, 0.02, 0.012); welt.translate(-0.24, 0.24, surfZ(P, -0.24, 0.24, 0.008)); add('metal', welt); }
    else { const patch = new THREE.BoxGeometry(0.1, 0.05, 0.01); patch.translate(-0.25, 0.26, surfZ(P, -0.25, 0.26, 0.01)); add('accent', patch); }
  } else {
    buildOuter(variant, P, add);
  }
  return parts;
}

// Shell / field / coach: front details that are mostly boxes, tubes and shells on the torso surface
function buildOuter(variant, P, add) {
  const hemY = P[0][1];
  const onSurf = (x, y, w, hgt, d, lift = 0.012) => {
    const b = new THREE.BoxGeometry(w, hgt, d);
    b.rotateY(Math.atan2(x, surfZ(P, x, y) / ZS) * 0.8); b.translate(x, y, surfZ(P, x, y, lift)); return b;
  };
  // centre front closure (zip for shell, placket for field/coach)
  const zp = []; for (let i = 0; i <= 18; i++) { const y = hemY + 0.02 + ((0.66 - hemY) * i) / 18; zp.push(new THREE.Vector3(0, y, surfZ(P, 0, Math.min(y, 0.62)))); }
  if (variant === 'shell') add('metal', tube(zp, 0.011, 36));
  else add('leather', tube(zp, 0.022, 36));
  if (variant !== 'shell') {
    // buttons / snaps down the placket
    const n = variant === 'coach' ? 5 : 6;
    for (let i = 0; i < n; i++) { const y = hemY + 0.12 + (i * (0.58 - hemY - 0.12)) / (n - 1); const b = new THREE.CylinderGeometry(0.022, 0.022, 0.012, 14); b.rotateX(Math.PI / 2); b.translate(0, y, surfZ(P, 0, y, 0.03)); add('metal', b); }
  }
  if (variant === 'shell') {
    // hood: a part-sphere behind the neck, opening facing forward, with a lime toggle cord
    const hood = new THREE.SphereGeometry(0.27, 28, 16, Math.PI * 0.62, Math.PI * 1.76, 0, Math.PI * 0.62);
    hood.scale(1, 1.15, 1); hood.translate(0, 0.72, -0.07); add('leather', hood);
    const collar = new THREE.CylinderGeometry(0.21, 0.23, 0.16, 32, 1, true); collar.scale(1, 1, 0.82); collar.translate(0, 0.72, 0); add('leather', collar);
    for (const side of [-1, 1]) {
      const cord = []; for (let i = 0; i <= 6; i++) { const y = 0.64 - i * 0.04; cord.push(new THREE.Vector3(side * 0.06, y, surfZ(P, 0.06, 0.6, 0.05 - i * 0.002))); }
      add('accent', tube(cord, 0.006, 8));
      // taped side seam from armpit to hem
      const seam = []; for (let i = 0; i <= 12; i++) { const y = 0.34 - (i / 12) * (0.34 - hemY); const r = radiusAt(P, y); seam.push(new THREE.Vector3(side * r * 0.98, y, 0.02)); }
      add('accent', tube(seam, 0.007, 24));
      // chest pocket zip, angled
      if (side === 1) { const pz = []; for (let i = 0; i <= 5; i++) { const t = i / 5, x = 0.14 + 0.16 * t, y = 0.3 - 0.08 * t; pz.push(new THREE.Vector3(x, y, surfZ(P, x, y))); } add('metal', tube(pz, 0.008, 10)); }
      add('leather', onSurf(side * 0.3, hemY + 0.28, 0.2, 0.03, 0.02)); // hand-warmer flap
    }
    // drop-tail hem
    const rh = radiusAt(P, hemY);
    const hem = new THREE.TorusGeometry(rh + 0.004, 0.012, 6, 40); hem.rotateX(Math.PI / 2); hem.scale(1, 1, ZS); hem.translate(0, hemY + 0.01, 0); add('accent', hem);
  } else if (variant === 'field') {
    // stand-fall collar
    const collar = new THREE.CylinderGeometry(0.22, 0.27, 0.13, 32, 1, true); collar.scale(1, 1, 0.82); collar.translate(0, 0.7, 0); add('leather', collar);
    for (const side of [-1, 1]) {
      // two bellowed chest pockets + two big cargo pockets, each with a flap and a snap
      for (const [y, w, hgt] of [[0.2, 0.2, 0.18], [hemY + 0.24, 0.24, 0.24]]) {
        const x = side * (y > 0 ? 0.22 : 0.26);
        add('leather', onSurf(x, y, w, hgt, 0.03, 0.014));
        add('leather', onSurf(x, y + hgt / 2 + 0.015, w + 0.02, 0.05, 0.02, 0.03));
        const s = new THREE.CylinderGeometry(0.014, 0.014, 0.01, 10); s.rotateX(Math.PI / 2); s.translate(x, y + hgt / 2, surfZ(P, x, y, 0.05)); add('metal', s);
      }
    }
    // waist drawcord channel
    const wy = -0.06, rw = radiusAt(P, wy);
    const cord = new THREE.TorusGeometry(rw + 0.006, 0.01, 6, 40); cord.rotateX(Math.PI / 2); cord.scale(1, 1, ZS); cord.translate(0, wy, 0); add('accent', cord);
  } else {
    // coach: shirt collar (flared, turned down), drawcord hem, lime chest print
    const collar = new THREE.CylinderGeometry(0.21, 0.3, 0.11, 32, 1, true); collar.scale(1, 1, 0.82); collar.translate(0, 0.66, 0.01); add('leather', collar);
    const rh = radiusAt(P, hemY);
    const hem = new THREE.TorusGeometry(rh + 0.006, 0.013, 6, 40); hem.rotateX(Math.PI / 2); hem.scale(1, 1, ZS); hem.translate(0, hemY + 0.03, 0); add('rib', hem);
    for (const side of [-1, 1]) { const tip = new THREE.CylinderGeometry(0.012, 0.012, 0.07, 8); tip.translate(side * 0.1, hemY - 0.02, surfZ(P, 0.1, hemY + 0.03, 0.02)); add('accent', tip); }
    // print: an orbit ring and a small planet on the left chest
    const ring = new THREE.TorusGeometry(0.06, 0.006, 6, 32); ring.scale(1, 0.45, 1); ring.translate(-0.25, 0.26, surfZ(P, -0.25, 0.26, 0.012)); add('accent', ring);
    const dot = new THREE.CircleGeometry(0.024, 18); dot.translate(-0.25, 0.26, surfZ(P, -0.25, 0.26, 0.014)); add('accent', dot);
    for (const side of [-1, 1]) add('leather', onSurf(side * 0.29, hemY + 0.22, 0.02, 0.18, 0.02)); // welt hand pockets
  }
}

function clean(g) {
  let n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k);
  if (!n.attributes.uv) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((n.attributes.position.count) * 2), 2));
  return n;
}

const cache = new Map();
/** Build (once) and cache merged geometries + materials for a variant. */
export function jacketAssets(variant = 'moto') {
  if (cache.has(variant)) return cache.get(variant);
  const parts = buildParts(variant);
  const mats = makeMaterials(variant);
  const meshes = [];
  for (const k of Object.keys(parts)) {
    if (!parts[k].length) continue;
    const geo = mergeGeometries(parts[k].map(clean), false);
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    meshes.push({ geo, mat: mats[k], key: k });
  }
  // centre on the bounding box
  const box = new THREE.Box3();
  meshes.forEach((m) => box.union(m.geo.boundingBox));
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  meshes.forEach((m) => { m.geo.translate(-c.x, -c.y, -c.z); m.geo.computeBoundingSphere(); m.geo.computeBoundingBox(); });
  const out = { meshes, mats, size, maxDim: Math.max(size.x, size.y, size.z) };
  cache.set(variant, out);
  return out;
}

/**
 * New jacket Group sharing cached geometry. `cloneMaterials` gives the instance its own
 * materials (needed when instances fade independently, e.g. the home carousel).
 * The group is normalised like the original: scale = targetSize / maxDim.
 */
export function createJacket(variant = 'moto', { targetSize = 2, cloneMaterials = false } = {}) {
  const a = jacketAssets(variant);
  const g = new THREE.Group(); g.name = `jacket-${variant}`;
  const inner = new THREE.Group(); inner.scale.setScalar(targetSize / a.maxDim); g.add(inner);
  for (const m of a.meshes) {
    const mat = cloneMaterials ? m.mat.clone() : m.mat;
    const mesh = new THREE.Mesh(m.geo, mat); mesh.name = m.key; inner.add(mesh);
  }
  g.userData.variant = variant;
  return g;
}

/** Real-world-scale copy for AR export (≈0.72 m tall, centred). */
export function createJacketForExport(variant) {
  const a = jacketAssets(variant);
  return createJacket(variant, { targetSize: a.maxDim * (0.72 / a.size.y) });
}
