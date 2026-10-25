// scenes/ArViewer.js — the original's ARViewer (3d-ar-notes §3.2, §5).
//
//   * hand-written orbit viewer: the MODEL rotates on a pivot, the camera stays on +Z
//   * drag yaw/pitch .006 rad/px, velocity = lerp(v, d/dt, .4), no fling if still > 80 ms,
//     inertia e^(−5.75 dt), auto-turntable .3 rad/s resuming 1.2 s after input
//   * zoom = log(FOV) between log(12°) and log(framedFov) + radius between min/max radius,
//     both through critically-damped Dampers (decay 50 ms) — model-viewer's feel
//   * portrait FOV compensation: framedFov = 2·atan(tan(15°) / min(aspect, 1))
//   * mobile: lazily loads <model-viewer> from jsDelivr, points it at a GLB exported on the
//     fly with GLTFExporter from the procedural jacket, and shows [ VIEW IN YOUR SPACE ] only
//     if `canActivateAR` is true after `load` (WebXR on Android, Quick Look via on-device
//     USDZ on iOS). Desktop: a QR handoff to /ar/:sku on your phone (the original had none).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createJacket, createJacketForExport } from '../three/jacket.js';
import { Damper, clamp } from '../core/math.js';
import { reducedMotion, isMobileUA } from '../core/env.js';
import { variantOf } from '../core/store.js';

const ORBIT = { autoSpeed: 0.3, autoResumeDelay: 1.2, dragSpeed: 0.006, pitchLimit: 1 };
const ZOOM = { framedFovDeg: 30, minFovDeg: 12, startRadiusRatio: 1.05, minRadiusRatio: 2.2, sensitivity: 0.04, decayMs: 50 };
const MODEL_VIEWER = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js';
const QR_LIB = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

export function createArViewer({ container, product, onReady }) {
  const reduced = reducedMotion();
  const wrap = document.createElement('div'); wrap.className = 'ar-viewer';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `${product.name} — 3D view. Drag or use arrow keys to rotate, + and − to zoom.`);
  canvas.tabIndex = 0;
  wrap.append(canvas); container.append(wrap);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  const pivot = new THREE.Group(); scene.add(pivot);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04); scene.environment = envRT.texture;

  const model = createJacket(variantOf(product), { targetSize: 2 });
  pivot.add(model);
  const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
  model.position.sub(box.getCenter(new THREE.Vector3()));
  const r = size.length() / 2;
  const maxRadius = (r / Math.sin(THREE.MathUtils.degToRad(ZOOM.framedFovDeg / 2))) * ZOOM.startRadiusRatio;
  const minRadius = Math.min(r * ZOOM.minRadiusRatio, maxRadius);
  let radius = maxRadius, goalRadius = maxRadius;
  let framedFov = ZOOM.framedFovDeg, logFov = Math.log(framedFov), goalLogFov = logFov, zoomT = 0;
  const radDamper = new Damper(ZOOM.decayMs), fovDamper = new Damper(ZOOM.decayMs);

  let yaw = 0.5, pitch = 0.08, velYaw = 0, velPitch = 0, idle = 0, autoK = reduced ? 0 : 1;
  let dragging = false, lastX = 0, lastY = 0, lastT = 0, dead = false;

  function setZoom(t) {
    zoomT = clamp(t, 0, 1);
    goalLogFov = Math.log(framedFov) + (Math.log(ZOOM.minFovDeg) - Math.log(framedFov)) * zoomT;
    goalRadius = maxRadius + (minRadius - maxRadius) * zoomT;
  }
  const ro = new ResizeObserver(() => {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    framedFov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(15)) / Math.min(camera.aspect, 1)));
    setZoom(zoomT); camera.updateProjectionMatrix();
  });
  ro.observe(canvas);

  const onDown = (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; lastT = performance.now(); velYaw = velPitch = 0; canvas.setPointerCapture?.(e.pointerId); idle = 0; autoK = 0; };
  const onMove = (e) => {
    if (!dragging) return;
    const now = performance.now(), dt = Math.max((now - lastT) / 1000, 1e-3);
    const dx = (e.clientX - lastX) * ORBIT.dragSpeed, dy = (e.clientY - lastY) * ORBIT.dragSpeed;
    yaw += dx; pitch = clamp(pitch + dy, -1, ORBIT.pitchLimit);
    velYaw += (dx / dt - velYaw) * 0.4; velPitch += (dy / dt - velPitch) * 0.4;
    lastX = e.clientX; lastY = e.clientY; lastT = now;
  };
  const onUp = () => { if (!dragging) return; dragging = false; if (performance.now() - lastT > 80) velYaw = velPitch = 0; idle = 0; };
  const onWheel = (e) => { e.preventDefault(); setZoom(zoomT - Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100) * ZOOM.sensitivity * 0.05); idle = 0; };
  const onKey = (e) => {
    const k = e.key;
    if (k === 'ArrowLeft') yaw -= 0.15; else if (k === 'ArrowRight') yaw += 0.15;
    else if (k === 'ArrowUp') pitch = clamp(pitch - 0.1, -1, 1); else if (k === 'ArrowDown') pitch = clamp(pitch + 0.1, -1, 1);
    else if (k === '+' || k === '=') setZoom(zoomT + 0.15); else if (k === '-' || k === '_') setZoom(zoomT - 0.15);
    else return;
    e.preventDefault(); idle = 0; autoK = 0;
  };
  // pinch zoom
  const touches = new Map(); let pinch0 = 0, zoom0 = 0;
  const onTouch = (e) => {
    for (const t of e.changedTouches) e.type === 'touchend' || e.type === 'touchcancel' ? touches.delete(t.identifier) : touches.set(t.identifier, t);
    if (touches.size === 2) {
      const [a, b] = [...touches.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (e.type === 'touchstart') { pinch0 = d; zoom0 = zoomT; dragging = false; } else if (pinch0) setZoom(zoom0 + (d / pinch0 - 1));
    } else pinch0 = 0;
  };
  canvas.addEventListener('pointerdown', onDown); addEventListener('pointermove', onMove); addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false }); canvas.addEventListener('keydown', onKey);
  ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((t) => canvas.addEventListener(t, onTouch, { passive: true }));

  let last = performance.now(), paused = false;
  function tick() {
    if (dead || paused) return;
    const now = performance.now(), dt = Math.min((now - last) / 1000, 0.1); last = now;
    if (!dragging) {
      const k = Math.exp(-5.75 * dt); velYaw *= k; velPitch *= k;
      yaw += velYaw * dt; pitch = clamp(pitch + velPitch * dt, -1, ORBIT.pitchLimit);
      idle += dt;
      if (!reduced && idle > ORBIT.autoResumeDelay) autoK += (1 - autoK) * (1 - Math.exp(-1.2 * dt));
      yaw += ORBIT.autoSpeed * autoK * dt;
    }
    radius = radDamper.update(radius, goalRadius, dt * 1000, maxRadius);
    logFov = fovDamper.update(logFov, goalLogFov, dt * 1000, 1);
    camera.fov = Math.exp(logFov); camera.updateProjectionMatrix();
    pivot.rotation.set(pitch, yaw, 0, 'XYZ');
    camera.position.set(0, 0, radius); camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }
  renderer.compile(scene, camera);
  renderer.setAnimationLoop(tick);
  requestAnimationFrame(() => { wrap.classList.add('is-ready'); onReady?.(); });

  return {
    el: wrap,
    setPaused(v) { paused = !!v; if (!paused) last = performance.now(); },
    destroy() {
      dead = true; renderer.setAnimationLoop(null); ro.disconnect();
      removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp);
      envRT.dispose(); pmrem.dispose(); renderer.dispose(); renderer.forceContextLoss(); wrap.remove();
    },
  };
}

// ------------------------------------------------------------------ AR (mobile)
let mvPromise = null;
function loadModelViewer() {
  if (customElements.get('model-viewer')) return Promise.resolve();
  if (!mvPromise) mvPromise = new Promise((res, rej) => {
    const s = document.createElement('script'); s.type = 'module'; s.src = MODEL_VIEWER;
    s.onload = () => customElements.whenDefined('model-viewer').then(res); s.onerror = () => rej(new Error('model-viewer failed to load'));
    document.head.append(s);
  });
  return mvPromise;
}
const glbCache = new Map();
/** Export the procedural jacket to a binary GLB blob URL (real-world scale ≈0.72 m). */
export async function exportJacketGLB(variant) {
  if (glbCache.has(variant)) return glbCache.get(variant);
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const p = new GLTFExporter().parseAsync(createJacketForExport(variant), { binary: true })
    .then((buf) => URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' })));
  glbCache.set(variant, p);
  return p;
}

/**
 * Mount the hidden <model-viewer> AR launcher (mobile only). Resolves with
 * { canActivateAR, activate() } once model-viewer has loaded the GLB.
 */
export async function mountArLauncher(host, product) {
  if (!isMobileUA()) return { canActivateAR: false, reason: 'desktop' };
  await loadModelViewer();
  const src = await exportJacketGLB(variantOf(product));
  const mv = document.createElement('model-viewer');
  mv.className = 'ar-launcher'; mv.setAttribute('aria-hidden', 'true');
  mv.setAttribute('src', src); mv.setAttribute('alt', product.name);
  mv.setAttribute('ar', ''); mv.setAttribute('ar-modes', 'webxr quick-look'); // blob src → no scene-viewer
  mv.setAttribute('ar-placement', 'floor'); mv.setAttribute('loading', 'eager');
  const exit = document.createElement('button'); exit.slot = 'exit-webxr-ar-button'; exit.className = 'btn-bracket'; exit.textContent = '[CLOSE]';
  mv.append(exit); host.append(mv);
  await new Promise((res) => { mv.addEventListener('load', res, { once: true }); mv.addEventListener('error', res, { once: true }); setTimeout(res, 15000); });
  return { canActivateAR: !!mv.canActivateAR, activate: () => mv.activateAR(), el: mv };
}

/** Desktop handoff: a real QR code for /ar/:sku (qrcode-generator from jsDelivr, text fallback). */
export async function renderQr(el, url) {
  try {
    if (!window.qrcode) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = QR_LIB; s.onload = res; s.onerror = rej; document.head.append(s); });
    const qr = window.qrcode(0, 'M'); qr.addData(url); qr.make();
    const n = qr.getModuleCount();
    let path = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) path += `M${x} ${y}h1v1h-1z`;
    el.innerHTML = `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code for ${url}"><path d="${path}" fill="#000"/></svg>`;
    return true;
  } catch { el.textContent = url; return false; }
}
