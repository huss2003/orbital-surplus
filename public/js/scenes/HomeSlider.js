// scenes/HomeSlider.js — home "/" and 404 (design-notes §2 Home, §4.3, §4.4; 3d-ar-notes §0).
//
// The original is a carousel of pre-rendered turntable VIDEOS on 9:16 planes with a
// "whole" render and a "wireframe" render mixed through a cursor-following square mask.
// Here the turntable is real-time: each carousel slot holds a procedural jacket, a second
// scene renders the focused jacket as a hidden-line wireframe into a render target, and a
// composite pass shows that wireframe inside a Chebyshev (square) window under the cursor.
//
// Physics (§4.3, verbatim constants): lerp .04 (coarse .12, key boost .08 for 700 ms),
// snap .1, speed decay .95, wheel ×.5×.001, drag .005/px (touch ×1.4 on mobile),
// spacing grows with smoothed speed, focus = smoothstep(1 − |offset|),
// scale = (inactive + (active − inactive)·focus)·mult, opacity = max(.2, 1 − |offset|·.4).
// Intro: target = −round(5/items)·items with a speed kick of 5 (desktop) → it whips ~2 loops.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createJacket, jacketAssets } from '../three/jacket.js';
import { HomeCompositeShader } from '../three/shaders.js';
import { createPostChain, ShaderPass } from '../three/post.js';
import { gsap } from '../core/gsap.js';
import { clamp, damp, smoothstep, mod, approach } from '../core/math.js';
import { dprGovernor } from '../core/dprGovernor.js';
import { reducedMotion, isMobile, isCoarse } from '../core/env.js';
import { sound } from '../core/sound.js';
import { cursor } from '../core/cursor.js';
import { dialogStack } from '../core/dialog.js';
import { variantOf } from '../core/store.js';

const C = { lerp: 0.04, lerpMobile: 0.12, keyLerp: 0.08, snap: 0.1, scrollSpeed: 0.001, mouseMult: 0.5, dragSens: 0.005, keyCooldown: 200, speedDecay: 0.95 };
const layout = () => {
  const m = isMobile();
  return {
    active: m ? 1.2 : 1.3, inactive: m ? 0.65 : 0.75,
    mult: innerWidth > 1024 ? 6.6 : innerWidth > 768 ? 6 : 5.8,
    spacing: m ? 3.6 : 4,
  };
};
// speed-driven edge FX tiers (shared config `ft`): px/s → blur px / chroma px
const TIERS = [20, 1000, 3000, 6000], BLUR = [32, 64, 128, 256], CHROMA = [9, 18, 27, 36];
function tierValue(speed, table) {
  if (speed < TIERS[0]) return 0;
  for (let i = 1; i < TIERS.length; i++) if (speed < TIERS[i]) return table[i - 1] + (table[i] - table[i - 1]) * ((speed - TIERS[i - 1]) / (TIERS[i] - TIERS[i - 1]));
  return table[table.length - 1];
}
const JACKET_IN_PLANE = 0.55;   // jacket width as a fraction of the (virtual) 9:16 plane height

export function createHomeSlider({ container, products, notFound = false, progress, onLand, onActivate }) {
  const reduced = reducedMotion();
  const N = products.length;
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 100);
  camera.position.z = 10;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;

  // ---------------------------------------------------------------- carousel slots
  const SLOT_OFFS = notFound ? [0] : [-2, -1, 0, 1, 2];
  const variants = [...new Set(products.map(variantOf))];
  const slots = SLOT_OFFS.map((k) => {
    const g = new THREE.Group(); g.userData.k = k;
    g.userData.byVariant = {};
    for (const v of variants) {
      const j = createJacket(v, { targetSize: 1, cloneMaterials: true });
      j.visible = false; g.add(j); g.userData.byVariant[v] = j;
    }
    scene.add(g);
    return g;
  });

  // wireframe "back" scene: black hidden-line solid + white edges for the focused jacket
  const wireScene = new THREE.Scene();
  const wireRoot = new THREE.Group(); wireScene.add(wireRoot);
  const occluder = new THREE.MeshBasicMaterial({ color: 0x000000, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  const wireByVariant = {};
  for (const v of variants) {
    const a = jacketAssets(v);
    const g = new THREE.Group(); const inner = new THREE.Group(); inner.scale.setScalar(1 / a.maxDim); g.add(inner);
    for (const m of a.meshes) { inner.add(new THREE.Mesh(m.geo, occluder)); inner.add(new THREE.LineSegments(new THREE.WireframeGeometry(m.geo), lineMat)); }
    g.visible = false; wireRoot.add(g); wireByVariant[v] = g;
  }
  const wireRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });

  const composite = new ShaderPass(HomeCompositeShader);
  composite.uniforms.tWire.value = wireRT.texture;
  if (notFound) { composite.uniforms.uOpacity.value = 0.1; composite.uniforms.uBlur.value = 6; composite.uniforms.uPulse.value = 0; }
  if (reduced) composite.uniforms.uPulse.value = 0;
  const post = createPostChain(renderer, scene, camera, { main: [composite], ditherMax: 0.8 });

  // ---------------------------------------------------------------- state
  const S = { current: 0, target: 0, speed: 0, lspeed: 0 };
  let L = layout(), keyBoostUntil = 0, lastKey = 0, landed = -999, dead = false, spin = 0, time = 0;
  let fxBlur = 0, fxChroma = 0, bend = 0, prevCurrent = 0;
  const reveal = { value: 0 };
  let hovering = false;
  const mousePx = new THREE.Vector2(-9999, -9999), ndc = new THREE.Vector2(-9, -9);
  const raycaster = new THREE.Raycaster(), box = new THREE.Box3();
  let governor = null;

  function resize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false); post.setSize(w, h);
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    wireRT.setSize(db.x, db.y); composite.uniforms.uResolution.value.copy(db);
    L = layout();
  }
  addEventListener('resize', resize); resize();

  // ---------------------------------------------------------------- input
  const coarse = isCoarse();
  let drag = null;
  const onDown = (e) => {
    if (notFound || dialogStack.length) return;
    drag = { x: e.clientX, y: e.clientY, start: S.target, axis: null, moved: false, id: e.pointerId };
  };
  const onMove = (e) => {
    mousePx.set(e.clientX, e.clientY);
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (e.pointerType === 'touch' && !drag.axis) { if (Math.hypot(dx, dy) < 8) return; drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; }
    const d = drag.axis === 'y' ? dy : dx;
    const mult = e.pointerType === 'touch' && isMobile() ? 1.4 : 1;
    if (Math.abs(d) > 3) drag.moved = true;
    const prev = S.target;
    S.target = drag.start + d * C.dragSens * mult;
    S.speed = clamp(S.speed + (S.target - prev) * 2, -1, 1);
    sound.play('drag');
  };
  const onUp = (e) => {
    if (!drag) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5;
    drag = null;
    // click in the central box (x 35–65 %, y 20–80 %) → /shop. The jacket itself has no handler.
    const fx = e.clientX / innerWidth, fy = e.clientY / innerHeight;
    if (!moved && fx > 0.35 && fx < 0.65 && fy > 0.2 && fy < 0.8) onActivate?.();
  };
  const onWheel = (e) => {
    if (notFound || dialogStack.length) return;
    e.preventDefault();
    const delta = (e.wheelDeltaX || -e.deltaX) + (e.wheelDeltaY || -e.deltaY);
    if (Math.abs(delta) >= 100 && e.deltaMode === 0 && Math.abs(e.deltaY) >= 50) {
      // Skeleton addition: a discrete mouse-wheel notch steps one item (the original's
      // .0005-per-unit formula is tuned for trackpads and barely moves on a notched wheel).
      step(Math.sign(delta)); return;
    }
    S.target += delta * C.mouseMult * C.scrollSpeed;
    S.speed = clamp(S.speed + delta * C.mouseMult * 15e-5 * 5, -1, 1);
    sound.play('drag');
  };
  function step(dir) {
    const now = performance.now();
    if (now - lastKey < C.keyCooldown) return;
    lastKey = now; keyBoostUntil = now + 700;
    S.target = Math.round(S.target) + dir;
    sound.play('drag');
  }
  const onKey = (e) => {
    if (notFound || dialogStack.length || e.target.closest?.('input, textarea, select, [role="dialog"]')) return;
    if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { step(1); e.preventDefault(); }
    else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D' || (e.key === ' ' && e.target === document.body)) { step(-1); e.preventDefault(); }
  };
  container.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('pointerup', onUp);
  container.addEventListener('wheel', onWheel, { passive: false });
  addEventListener('keydown', onKey);

  // ---------------------------------------------------------------- frame
  const clock = new THREE.Clock();
  const fr = damp;
  function tick() {
    if (dead) return;
    const dt = Math.min(clock.getDelta(), 0.1); time += dt;
    governor?.frame(dt);

    // §4.3 step(dt)
    S.speed = clamp(S.speed * Math.pow(C.speedDecay, 2 * dt * 60), -1, 1);
    S.lspeed += ((coarse ? 0 : Math.abs(S.speed)) - S.lspeed) * fr(0.1, dt);
    if (!drag) S.target += (Math.round(S.target) - S.target) * fr(C.snap, dt);   // always snapping to an item
    const boost = performance.now() < keyBoostUntil;
    S.current += (S.target - S.current) * fr(boost ? C.keyLerp : coarse ? C.lerpMobile : C.lerp, dt);

    // speed in px/s drives edge blur / chroma / bend (attack 10, release 2.5 / bend 8, 4)
    const unitPx = innerHeight / (2 * Math.tan(THREE.MathUtils.degToRad(22.5)) * camera.position.z);
    const speedPx = Math.abs(S.current - prevCurrent) / Math.max(dt, 1e-4) * L.spacing * unitPx; prevCurrent = S.current;
    const tb = reduced ? 0 : tierValue(speedPx, BLUR), tc = reduced ? 0 : tierValue(speedPx, CHROMA);
    fxBlur = approach(fxBlur, tb, tb > fxBlur ? 10 : 2.5, dt);
    fxChroma = approach(fxChroma, tc, tc > fxChroma ? 10 : 2.5, dt);
    const tBend = reduced ? 0 : Math.min((speedPx * 60) / 1000, 300);
    bend = approach(bend, tBend, tBend > bend ? 8 : 4, dt);
    const pr = renderer.getPixelRatio();
    composite.uniforms.uBlurPx.value = fxBlur * 0.25 * pr;      // the 9-tap blur is cheap; scale the documented px down
    composite.uniforms.uChromaPx.value = fxChroma * pr;

    if (!reduced) spin += 0.55 * dt;                            // turntable
    const halfW = camera.position.z * Math.tan(THREE.MathUtils.degToRad(22.5)) * camera.aspect;
    let focusSlot = null, focusOffset = 9;
    for (const g of slots) {
      const v = Math.round(-S.current) + g.userData.k;
      const offset = notFound ? 0 : v + S.current;
      const product = products[mod(v, N)];
      const variant = variantOf(product);
      for (const [key, j] of Object.entries(g.userData.byVariant)) j.visible = key === variant;
      const ao = Math.abs(offset);
      const focus = smoothstep(0, 1, 1 - Math.min(ao, 1));
      const s = (L.inactive + (L.active - L.inactive) * focus) * L.mult;
      const x = offset * L.spacing * (1 + S.lspeed);
      const r2 = Math.min((x / Math.max(halfW, 1e-3)) ** 2, 1);
      g.position.set(x, 0, -(bend / 300) * 2.0 * (1 - r2));
      g.scale.setScalar(s * JACKET_IN_PLANE);
      g.rotation.y = spin + offset * 0.4;
      const op = notFound ? 1 : isMobile() ? 1 : Math.max(0.2, 1 - ao * 0.4);
      const j = g.userData.byVariant[variant];
      j.traverse((o) => { if (o.isMesh) { o.material.opacity = op; o.material.transparent = op < 0.999; o.material.depthWrite = op >= 0.999; } });
      g.visible = ao < 2.6;
      if (ao < focusOffset) { focusOffset = ao; focusSlot = g; }
    }

    // landing → re-key the HUD + ghost name
    const activeIdx = mod(Math.round(-S.current), N);
    if (!notFound && Math.abs(S.target - S.current) < 0.02 && activeIdx !== landed) { landed = activeIdx; onLand?.(products[activeIdx]); }

    // hover reveal on the focused plane (square window, §4.4)
    const handoff = smoothstep(0, 1, (0.5 - focusOffset) / 0.35);
    let sizeCss = 0;
    if (focusSlot && !notFound && !coarse) {
      const variant = variantOf(products[mod(Math.round(-S.current), N)]);
      const fj = focusSlot.userData.byVariant[variant];
      box.setFromObject(fj);
      raycaster.setFromCamera(ndc, camera);
      const hit = !drag && raycaster.ray.intersectsBox(box) && handoff > 0.5;
      if (hit !== hovering) {
        hovering = hit;
        gsap.killTweensOf(reveal);
        gsap.to(reveal, hit ? { value: 0.05, duration: 0.5, ease: 'circ.inOut' } : { value: 0, duration: 0.4, ease: 'power2.in' });
      }
      // plane height in CSS px = projected height of the virtual 9:16 plane (scale s)
      const planeH = (focusSlot.scale.x / JACKET_IN_PLANE) * unitPx;
      sizeCss = reveal.value * planeH * handoff;
      wireRoot.position.copy(focusSlot.position); wireRoot.rotation.copy(focusSlot.rotation); wireRoot.scale.copy(focusSlot.scale);
      for (const [key, w] of Object.entries(wireByVariant)) w.visible = key === variant;
    }
    composite.uniforms.uMouse.value.set(mousePx.x * pr, (innerHeight - mousePx.y) * pr);
    composite.uniforms.uSize.value = sizeCss * pr;
    composite.uniforms.uStrength.value = sizeCss > 0.5 ? handoff : 0;
    if (sizeCss > 0.5) cursor.open(sizeCss * 2); else cursor.close();
    if (sizeCss > 0.5) {                                        // render the wireframe layer only when visible
      renderer.setRenderTarget(wireRT); renderer.setClearColor(0, 1); renderer.clear(); renderer.render(wireScene, camera);
      renderer.setRenderTarget(null); renderer.setClearColor(0, 0);
    }
    composite.uniforms.uTime.value = time;
    post.render(dt);
  }

  const ready = (async () => {
    progress?.(0.3);
    try { await renderer.compileAsync(scene, camera); } catch { renderer.compile(scene, camera); }
    // warm the wire scene + dither/glitch programs once
    const prev = [post.dither.enabled, post.glitch.enabled];
    post.dither.enabled = post.glitch.enabled = true;
    for (const w of Object.values(wireByVariant)) w.visible = true;
    renderer.setRenderTarget(wireRT); renderer.render(wireScene, camera); renderer.setRenderTarget(null);
    post.render(0.016);
    [post.dither.enabled, post.glitch.enabled] = prev;
    progress?.(1);
    renderer.setAnimationLoop(tick);
  })();

  return {
    ready,
    startIntro() {
      governor = dprGovernor({ max: renderer.getPixelRatio(), min: Math.min(renderer.getPixelRatio(), 1), apply: (r) => { renderer.setPixelRatio(r); post.setPixelRatio(r); resize(); } });
      if (notFound || reduced) return;
      S.target = -Math.round(5 / N) * N;                         // whip through ~2 loops and settle
      if (!isMobile()) { S.speed = 5; S.lspeed = 5; }
    },
    destroy() {
      dead = true; cursor.close();
      renderer.setAnimationLoop(null);
      removeEventListener('resize', resize); removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); removeEventListener('keydown', onKey);
      gsap.killTweensOf(reveal);
      slots.forEach((g) => g.traverse((o) => { if (o.isMesh) o.material.dispose(); }));
      wireRoot.traverse((o) => { if (o.isLineSegments) o.geometry.dispose(); });
      occluder.dispose(); lineMat.dispose(); wireRT.dispose(); post.dispose(); envRT.dispose(); pmrem.dispose();
      renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    },
  };
}
