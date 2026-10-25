// scenes/ShopGrid.js — the infinite 3D "archive" at /shop and /shop/:slug
// (3d-ar-notes §1.3–1.5, §1.7; design-notes §2 Shop / Product, §4 tweens #16–#23).
//
//   * 7×5 grid (5×5 ≤768px), spacing 3.5, model scale .9 (1.125 mobile), toroidal wrap
//   * auto-rotate 1.6 × 0.01 rad per 60fps frame, shared angle J + per-cell rotOffset
//   * RoomEnvironment + PMREM instead of the original HDR (no punctual lights either way)
//   * EffectComposer: Render → Lens → Dither → Glitch → Ripple → Output
//   * intro dolly z 15 → 8/10/12/14 (2.5 s power3.inOut), then adaptive DPR + deep link
//   * focus: spin to next full turn (2.5 s power2.out), ripple (1.8 s power1.out),
//            pan + dolly (1.2 s expo.inOut), cursor-trail-masked wireframe, URL replace
//   * unfocus: rotOffset → 0 (1.2 s power2.out), camera out (1 s expo.inOut)
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createJacket } from '../three/jacket.js';
import { LensShader, RippleShader, gridMaterial, wireMaterial, radialSprite } from '../three/shaders.js';
import { createPostChain, ShaderPass } from '../three/post.js';
import { gsap } from '../core/gsap.js';
import { damp, lerp, wrapAngle, mod } from '../core/math.js';
import { dprGovernor } from '../core/dprGovernor.js';
import { reducedMotion, isMobile, isCoarse } from '../core/env.js';
import { sound } from '../core/sound.js';
import { dialogStack } from '../core/dialog.js';
import { variantOf } from '../core/store.js';

const GRID = () => ({ cols: isMobile() ? 5 : 7, rows: 5, spacing: 3.5, modelScale: isMobile() ? 1.125 : 0.9, autoRotateSpeed: 1.6 });
const FOCUS = { transitionDuration: 1.2, transitionEase: 'expo.inOut', depthStrengthX: 0.15, depthStrengthY: 0.2, rotationSpeed: 0.05 };
const camZ = () => (innerWidth <= 480 ? 14 : innerWidth <= 768 ? 12 : innerWidth <= 1024 ? 10 : 8);
const focusZ = (scale) => (innerWidth <= 480 ? 5 : innerWidth <= 768 ? 4.75 : innerWidth <= 1024 ? 3.5 : 3) * (scale / 0.8);

export function createShopGrid({ container, products, onFocus, onUnfocus, progress }) {
  const reduced = reducedMotion();
  let G = GRID();
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  container.append(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 0, 15);

  // image-based lighting only (the original: HDR equirect → PMREM). RoomEnvironment is HDR-less.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;

  // faint line grid behind the jackets
  const gridMat = gridMaterial();
  const gridPlane = new THREE.Mesh(new THREE.PlaneGeometry(220, 220), gridMat);
  gridPlane.position.z = -1.4; scene.add(gridPlane);

  // ---------------------------------------------------------------- cells
  const cellsGroup = new THREE.Group(); scene.add(cellsGroup);
  let cells = [];
  function buildGrid() {
    cells.forEach((c) => cellsGroup.remove(c)); cells = [];
    for (let r = 0; r < G.rows; r++) for (let c = 0; c < G.cols; c++) {
      const product = products[(r + c) % products.length];          // the jackets alternate diagonally
      const cell = new THREE.Group();
      cell.userData = { cell: true, product, rotOffset: Math.random() * 0, base: new THREE.Vector2((c - (G.cols - 1) / 2) * G.spacing, (r - (G.rows - 1) / 2) * G.spacing) };
      cell.add(createJacket(variantOf(product), { targetSize: G.modelScale * 2 }));
      cellsGroup.add(cell); cells.push(cell);
    }
  }
  buildGrid();

  // ---------------------------------------------------------------- trail (cursor-painted wireframe mask)
  const trailScene = new THREE.Scene();
  const trailCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10); trailCam.position.z = 1;
  const spriteTex = radialSprite();
  const trailRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
  const pool = [];
  const sprGeo = new THREE.PlaneGeometry(0.15, 0.15);
  for (let i = 0; i < 100; i++) {
    const m = new THREE.Mesh(sprGeo, new THREE.MeshBasicMaterial({ map: spriteTex, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    m.visible = false; trailScene.add(m); pool.push(m);
  }
  let poolIdx = 0, trailAlive = false, trailDirty = false;
  const lastSpawn = new THREE.Vector2(99, 99);
  const wireMat = wireMaterial(trailRT.texture);
  const wireCache = new WeakMap();
  let wireObjs = [];

  // ---------------------------------------------------------------- post chain
  const lens = new ShaderPass(LensShader);
  const ripple = new ShaderPass(RippleShader); ripple.enabled = false;
  const post = createPostChain(renderer, scene, camera, { main: [lens], after: [ripple], ditherMax: 1 });

  // ---------------------------------------------------------------- state
  const pan = new THREE.Vector2(), panTarget = new THREE.Vector2(), vel = new THREE.Vector2();
  const mouse = new THREE.Vector2(), mouseS = new THREE.Vector2(), ndc = new THREE.Vector2(-9, -9);
  let J = 0, focused = null, tiltReady = false, baseY = 0, focusAnimating = false, introDone = false, pendingSlug = null;
  let covered = false, dead = false, governor = null;
  const keys = new Set();
  const raycaster = new THREE.Raycaster();

  function resize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    post.setSize(w, h);
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    trailRT.setSize(Math.max(1, db.x * 0.5), Math.max(1, db.y * 0.5));
    wireMat.uniforms.uResolution.value.copy(db);
    ripple.uniforms.uResolution.value.set(w, h);
    trailCam.left = -w / h; trailCam.right = w / h; trailCam.updateProjectionMatrix();
    const g2 = GRID();
    if (g2.cols !== G.cols) { if (focused) unfocus(true); G = g2; buildGrid(); }
    if (introDone) gsap.to(camera.position, { z: focused ? focusZ(G.modelScale) : camZ(), duration: 0.5, ease: 'power2.out' });
  }
  addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------- input
  let down = null;
  const onDown = (e) => {
    if (dialogStack.length) return;
    down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: 0, id: e.pointerId };
    canvas.setPointerCapture?.(e.pointerId);
    vel.set(0, 0);
  };
  const onMove = (e) => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    mouse.set(ndc.x * 0.5, ndc.y * 0.5);
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.lx, dy = e.clientY - down.ly;
    down.lx = e.clientX; down.ly = e.clientY; down.moved += Math.abs(dx) + Math.abs(dy);
    if (focused) return;
    const k = 0.005 * (e.pointerType === 'touch' && isMobile() ? 1.3 : 1);
    panTarget.x += dx * k; panTarget.y -= dy * k;
    vel.set(dx * k, -dy * k);
  };
  const onUp = (e) => {
    if (!down) return;
    const click = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5;
    down = null;
    if (click) handleClick(e.clientX, e.clientY);
  };
  const onWheel = (e) => {
    if (focused || dialogStack.length) return;
    e.preventDefault();
    const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
    panTarget.x += e.deltaX * m * 0.005; panTarget.y -= e.deltaY * m * 0.005;
  };
  const isTyping = (t) => t && (t.closest?.('input, textarea, select, [role="radiogroup"], [role="dialog"]'));
  const KEYMAP = { w: [0, 1], arrowup: [0, 1], s: [0, -1], arrowdown: [0, -1], a: [-1, 0], arrowleft: [-1, 0], d: [1, 0], arrowright: [1, 0] };
  const onKey = (e) => {
    if (e.key === 'Escape' && focused && !dialogStack.length) { unfocus(); return; }
    if (isTyping(e.target) || dialogStack.length || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (KEYMAP[k]) { keys.add(k); if (k.startsWith('arrow')) e.preventDefault(); }
  };
  const onKeyUp = (e) => keys.delete(e.key.toLowerCase());
  canvas.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  addEventListener('keydown', onKey);
  addEventListener('keyup', onKeyUp);
  const onBlur = () => keys.clear(); addEventListener('blur', onBlur);

  function cellFromObject(o) { while (o && !o.userData?.cell) o = o.parent; return o; }
  function handleClick(x, y) {
    const p = new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
    raycaster.setFromCamera(p, camera);
    const hit = raycaster.intersectObjects(cells, true).find((h) => h.object.isMesh);
    const cell = hit && cellFromObject(hit.object);
    if (cell) focus(cell, new THREE.Vector2(x / innerWidth, 1 - y / innerHeight));
    else if (focused) unfocus();
  }

  // ---------------------------------------------------------------- wireframe overlay
  function addWire(cell) {
    removeWire();
    cell.traverse((o) => {
      if (!o.isMesh) return;
      let wg = wireCache.get(o.geometry);
      if (!wg) { wg = new THREE.WireframeGeometry(o.geometry); wireCache.set(o.geometry, wg); }
      const ls = new THREE.LineSegments(wg, wireMat); ls.renderOrder = 10; ls.raycast = () => {};
      o.add(ls); wireObjs.push(ls);
    });
  }
  function removeWire() { wireObjs.forEach((l) => l.parent?.remove(l)); wireObjs = []; }

  // ---------------------------------------------------------------- focus / unfocus timelines
  function focus(cell, clickUV = new THREE.Vector2(0.5, 0.5), { silent = false } = {}) {
    if (focused === cell) return;
    if (focused) releaseCell(focused);
    focused = cell; tiltReady = false; focusAnimating = true;
    sound.play('drop');
    const d = reduced ? 0.01 : 1;
    // 1. spin to face front: next full turn at least PI away (2.5 s power2.out)
    const cur = cell.rotation.y;
    baseY = Math.ceil((cur + Math.PI) / (Math.PI * 2)) * Math.PI * 2;
    gsap.killTweensOf(cell.rotation); gsap.killTweensOf(cell.userData);
    gsap.to(cell.rotation, { x: 0, y: baseY, z: 0, duration: 2.5 * d, ease: 'power2.out', onComplete: () => { if (focused === cell) tiltReady = true; } });
    // 2. ripple zoom from the click point (1.8 s power1.out)
    if (!reduced) {
      ripple.enabled = true; ripple.uniforms.uCenter.value.copy(clickUV); ripple.uniforms.uProgress.value = -0.1;
      gsap.killTweensOf(ripple.uniforms.uProgress);
      gsap.to(ripple.uniforms.uProgress, { value: 2.5, duration: 1.8, ease: 'power1.out', onComplete: () => { ripple.enabled = false; } });
    }
    // 3. pan the grid so the cell is centred + 4. dolly in (1.2 s expo.inOut)
    gsap.killTweensOf(panTarget);
    gsap.to(panTarget, { x: pan.x - cell.position.x, y: pan.y - cell.position.y, duration: FOCUS.transitionDuration * d, ease: FOCUS.transitionEase, onComplete: () => { focusAnimating = false; } });
    gsap.killTweensOf(camera.position);
    gsap.to(camera.position, { x: 0, y: 0, z: focusZ(G.modelScale), duration: FOCUS.transitionDuration * d, ease: FOCUS.transitionEase });
    addWire(cell); wireMat.uniforms.uShowTrail.value = 1;
    onFocus?.(cell.userData.product, { silent });
  }
  function releaseCell(cell) {
    gsap.killTweensOf(cell.rotation);
    cell.userData.rotOffset = wrapAngle(cell.rotation.y - J);      // rejoin the shared spin smoothly
    gsap.to(cell.userData, { rotOffset: 0, duration: 1.2, ease: 'power2.out' });
    gsap.to(cell.rotation, { x: 0, z: 0, duration: 1.2, ease: 'power2.out' });
  }
  function unfocus(silent = false) {
    if (!focused) return;
    const cell = focused; focused = null; tiltReady = false;
    releaseCell(cell);
    removeWire(); wireMat.uniforms.uShowTrail.value = 0;
    gsap.killTweensOf(camera.position);
    gsap.to(camera.position, { z: camZ(), x: 0, y: 0, duration: reduced ? 0.01 : 1, ease: 'expo.inOut' });
    if (!silent) onUnfocus?.();
  }
  function focusSlug(slug) {
    if (!introDone) { pendingSlug = slug; return; }
    const list = cells.filter((c) => c.userData.product.slug === slug);
    if (!list.length) return;
    list.sort((a, b) => a.position.length() - b.position.length());  // nearest to the centre
    focus(list[0], new THREE.Vector2(0.5, 0.5), { silent: true });
  }

  // ---------------------------------------------------------------- render loop
  const clock = new THREE.Clock();
  let time = 0;
  function tick() {
    if (dead) return;
    const dt = Math.min(clock.getDelta(), 0.1); time += dt;
    if (covered) return;                                     // AR viewer covers the scene
    governor?.frame(dt);

    // keys + inertia (0.25 units per frame)
    if (!focused) {
      for (const k of keys) { const [x, y] = KEYMAP[k]; panTarget.x -= x * 0.25 * dt * 60; panTarget.y -= y * 0.25 * dt * 60; }
      if (!down) { panTarget.addScaledVector(vel, dt * 60); vel.multiplyScalar(1 - damp(0.05, dt)); }
    }
    pan.lerp(panTarget, damp(focusAnimating ? 0.5 : 0.1, dt));
    gridMat.uniforms.uOffset.value.copy(pan);

    if (!reduced) J += G.autoRotateSpeed * 0.01 * dt * 60;
    const W = G.cols * G.spacing, H = G.rows * G.spacing;
    for (const c of cells) {
      const b = c.userData.base;
      c.position.set(mod(b.x + pan.x + W / 2, W) - W / 2, mod(b.y + pan.y + H / 2, H) - H / 2, 0);
      if (c !== focused) c.rotation.y = J + c.userData.rotOffset;
    }

    // focused jacket follows the mouse with a slight tilt
    mouseS.lerp(mouse, damp(FOCUS.rotationSpeed, dt));
    if (focused && tiltReady) {
      const f = damp(FOCUS.rotationSpeed, dt), r = focused.rotation;
      r.x = lerp(r.x, -mouseS.y * FOCUS.depthStrengthX, f);
      r.y = lerp(r.y, baseY + mouseS.x * FOCUS.depthStrengthY, f);
      r.z = lerp(r.z, -mouseS.x * 0.045, f);
    }

    // trail sprites: spawn when the mouse moved > .005 NDC, decay ×0.94/frame, grow toward 2, spin .02/frame
    if (focused) {
      const aspect = innerWidth / innerHeight;
      if (ndc.distanceTo(lastSpawn) > 0.005 && ndc.x > -2) {
        const s = pool[poolIdx++ % pool.length];
        s.visible = true; s.material.opacity = 0.5; s.scale.setScalar(1); s.position.set(ndc.x * aspect, ndc.y, 0);
        lastSpawn.copy(ndc);
      }
    }
    trailAlive = false;
    const dec = Math.pow(0.94, dt * 60), grow = Math.pow(0.96, dt * 60);
    for (const s of pool) {
      if (!s.visible) continue;
      s.material.opacity *= dec;
      const sc = 2 - (2 - s.scale.x) * grow; s.scale.setScalar(sc);
      s.rotation.z += 0.02 * dt * 60;
      if (s.material.opacity < 0.01) s.visible = false; else trailAlive = true;
    }
    if (trailAlive || trailDirty) {                         // render the trail RT only when needed
      renderer.setRenderTarget(trailRT); renderer.setClearColor(0, 0); renderer.clear(); renderer.render(trailScene, trailCam);
      renderer.setRenderTarget(null); trailDirty = trailAlive;
    }

    wireMat.uniforms.uTime.value = time;
    lens.uniforms.uTime.value = time;
    ripple.uniforms.uTime.value = time;
    post.render(dt);
  }

  // ---------------------------------------------------------------- warm-up + intro
  const ready = (async () => {
    progress?.(0.3);
    try { await renderer.compileAsync(scene, camera); } catch { renderer.compile(scene, camera); }
    progress?.(0.7);
    // render once with every pass enabled to compile their programs (the original's warm-up)
    const prev = [post.dither.enabled, post.glitch.enabled, ripple.enabled];
    post.dither.enabled = post.glitch.enabled = ripple.enabled = true;
    addWire(cells[0]); post.render(0.016); removeWire();
    [post.dither.enabled, post.glitch.enabled, ripple.enabled] = prev;
    post.render(0.016);
    progress?.(1);
    renderer.setAnimationLoop(tick);
  })();

  function startIntro() {
    const done = () => {
      introDone = true;
      governor = dprGovernor({
        max: renderer.getPixelRatio(), min: Math.min(renderer.getPixelRatio(), 1),
        apply: (r) => { renderer.setPixelRatio(r); post.setPixelRatio(r); resize(); },
      });
      if (pendingSlug) { const s = pendingSlug; pendingSlug = null; focusSlug(s); }
    };
    if (reduced) { camera.position.z = camZ(); done(); return; }
    gsap.to(camera.position, { z: camZ(), duration: 2.5, ease: 'power3.inOut', onComplete: done });
  }

  return {
    ready, startIntro, focusSlug,
    unfocus: () => unfocus(true),
    get focusedProduct() { return focused?.userData.product || null; },
    setCovered(v) { covered = !!v; },
    destroy() {
      dead = true;
      renderer.setAnimationLoop(null);
      removeEventListener('resize', resize); removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp);
      removeEventListener('keydown', onKey); removeEventListener('keyup', onKeyUp); removeEventListener('blur', onBlur);
      gsap.killTweensOf(camera.position); gsap.killTweensOf(panTarget);
      cells.forEach((c) => { gsap.killTweensOf(c.rotation); gsap.killTweensOf(c.userData); });
      post.dispose(); trailRT.dispose(); envRT.dispose(); pmrem.dispose(); gridMat.dispose(); wireMat.dispose(); spriteTex.dispose(); sprGeo.dispose();
      pool.forEach((p) => p.material.dispose());
      renderer.dispose(); renderer.forceContextLoss();
      canvas.remove();
    },
  };
}
