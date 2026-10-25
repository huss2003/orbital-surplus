// scenes/Playground.js — /playground (3d-ar-notes §4, §1.6; design-notes §2 Playground, §4.6).
//
// 2D-in-WebGL: an orthographic camera in pixel units.
//   * centre slider: 7 full-height planes (0.45·innerWidth wide, 0.8 on mobile), cover-fit in
//     the shader, BEND vertex chunk injected via onBeforeCompile, left/right edge blur + chroma
//     bands (.3) driven by scroll speed, gaps that open with speed (maxGapExpansion 150) bridged
//     by "honey" quads (the documented pinch/taper/blend shader)
//   * 16 thumbnails on a radius-300 wheel (150 mobile), rotated tangentially, spinning with the
//     scroll (angle = i·2π/16 + scroll·0.0015); odd ones inverted after <dithering_fragment>;
//     WHEEL ↔ GRID morph lerps progress with damp(.08); click flies a thumb to the centre ×3
//   * same physics as home (lerp .04 / .12, snap .1, decay .95, drag .005), intro +5 kick
// Media are generated canvas textures (the original streams 8 encrypted KTX2/MP4 files).
import * as THREE from 'three';
import { BEND_UNIFORMS, BEND_CHUNK } from '../three/shaders.js';
import { createPostChain } from '../three/post.js';
import { gsap } from '../core/gsap.js';
import { clamp, damp, mod, approach } from '../core/math.js';
import { reducedMotion, isMobile, isCoarse } from '../core/env.js';
import { sound } from '../core/sound.js';
import { dialogStack } from '../core/dialog.js';

export const TITLES = ['PIXEL DREAMS', 'ORBIT RUNNER', 'NOISE FIELD', 'META FRAME', 'ECHO LENS', 'REVEAL NODE', 'SHOCKWAVE', 'VOID DRIFTER'];
const COUNT = 16;
const FT = { blurMax: 64, chroma: 18, band: 0.3, bendStrength: 60, bendMaxPx: 300, bendFocal: 1000, bendProfile: 2, bendAttack: 8, bendRelease: 4,
  honeyPinch: 1, honeyTaper: 4.9, honeyBlend: 0.5, honeyLag: 0.08, maxGapExpansion: 150, gapSpeedStrength: 40, attack: 10, release: 2.5 };

// ------------------------------------------------------------ generated media
const BAYER4 = [16, 5, 13, 1, 8, 12, 4, 9, 14, 2, 15, 3, 6, 10, 7, 11].map((v) => v / 17);
export function makeArt(i, w = 384, h = 576) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  const palettes = [['#000', '#fff'], ['#fff', '#000'], ['#C8FF2E', '#000'], ['#0a0a0a', '#C8FF2E']];
  const [bg, fg] = palettes[i % palettes.length];
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // ordered-dither radial blob (Bayer 4×4 at 3px cells)
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const fgc = fg === '#fff' ? [255, 255, 255] : fg === '#C8FF2E' ? [200, 255, 46] : [0, 0, 0];
  const cx = w * (0.3 + 0.4 * ((i * 37) % 10) / 10), cy = h * (0.25 + 0.5 * ((i * 53) % 10) / 10), R = w * (0.45 + (i % 4) * 0.12);
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    const t = 1 - Math.min(1, Math.hypot(x - cx, (y - cy) * (i % 2 ? 0.7 : 1.2)) / R);
    const th = BAYER4[((y / 3) & 3) * 4 + ((x / 3) & 3)];
    if (t * t > th) for (let yy = 0; yy < 3; yy++) for (let xx = 0; xx < 3; xx++) { const k = ((y + yy) * w + (x + xx)) * 4; if (k < d.length) { d[k] = fgc[0]; d[k + 1] = fgc[1]; d[k + 2] = fgc[2]; } }
  }
  g.putImageData(img, 0, 0);
  g.strokeStyle = fg; g.globalAlpha = 0.35; g.lineWidth = 1;
  for (let x = 0; x <= w; x += 32) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); g.stroke(); }
  g.globalAlpha = 1; g.fillStyle = fg === '#000' && bg === '#C8FF2E' ? '#fff' : fg;
  g.font = `${Math.round(w * 0.36)}px DotGothic16, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(i + 1).padStart(2, '0'), w / 2, h * 0.5);
  g.font = `${Math.round(w * 0.045)}px DotGothic16, monospace`; g.textAlign = 'left';
  g.fillText(`OS-${String(i + 1).padStart(3, '0')} // ${TITLES[i % TITLES.length]}`, 16, h - 22);
  g.fillText('[ORBITAL SURPLUS]', 16, 26);
  return c;
}

// ------------------------------------------------------------ honey bridge material (§1.6)
function honeyMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthTest: false,
    uniforms: { uTexA: { value: null }, uTexB: { value: null }, uPinch: { value: 1 }, uTaper: { value: FT.honeyTaper }, uBlend: { value: FT.honeyBlend },
      uPinchPos: { value: 0.5 }, uSmear: { value: 0.02 }, uHeight: { value: 1 }, hA: { value: 1 }, hB: { value: 1 }, uCoverA: { value: new THREE.Vector2(1, 1) }, uOpacity: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D uTexA, uTexB; uniform float uPinch, uTaper, uBlend, uPinchPos, uSmear, uHeight, hA, hB, uOpacity; uniform vec2 uCoverA; varying vec2 vUv;
      void main(){
        float s = vUv.x;                                    // 0 at card A, 1 at card B
        float pp = clamp(uPinchPos, 0.05, 0.95);
        float h = s < pp ? 0.5 * s / pp : 0.5 + 0.5 * (s - pp) / (1.0 - pp);
        float taper = pow(1.0 - sin(3.14159265 * h), uTaper);  // 1 at the ends, 0 in the middle
        float halfH = mix(min(hA, hB) * 0.5 * uPinch, mix(hA, hB, s) * 0.5, taper);
        float d = abs((vUv.y - 0.5) * uHeight) - halfH; float aa = max(fwidth(d), 1e-6);
        float alpha = 1.0 - smoothstep(-aa, aa, d); if (alpha <= 0.001) discard;
        float v = (vUv.y - 0.5) * uCoverA.y + 0.5;
        vec3 colA = texture2D(uTexA, vec2(0.5 + (0.998 - uSmear * s - 0.5) * uCoverA.x, v)).rgb;       // stretch A's last column
        vec3 colB = texture2D(uTexB, vec2(0.5 + (0.002 + uSmear * (1.0 - s) - 0.5) * uCoverA.x, v)).rgb; // stretch B's first column
        gl_FragColor = vec4(mix(colA, colB, smoothstep(pp - uBlend * 0.5, pp + uBlend * 0.5, s)), alpha * uOpacity);
        #include <colorspace_fragment>
      }`,
  });
}

/** MeshBasicMaterial + bend + cover-fit + edge blur/chroma (+ optional invert). */
function patchedMaterial(map, { invert = false, edgeFx = true, shared }) {
  const m = new THREE.MeshBasicMaterial({ map, transparent: true });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, shared, { uInvert: { value: invert ? 1 : 0 }, uEdge: { value: edgeFx ? 1 : 0 } });
    sh.vertexShader = BEND_UNIFORMS + sh.vertexShader.replace('#include <project_vertex>', BEND_CHUNK);
    sh.fragmentShader = `uniform vec2 uRes, uCover; uniform float uBlurPx, uChromaPx, uBand, uInvert, uEdge, uPlaneW;\n` + sh.fragmentShader
      .replace('#include <map_fragment>', `
        vec2 cuv = (vMapUv - 0.5) * mix(vec2(1.0), uCover, uEdge) + 0.5;
        float sx = gl_FragCoord.x / uRes.x;
        float band = uEdge * max(smoothstep(uBand, 0.0, sx), smoothstep(1.0 - uBand, 1.0, sx));
        vec4 sampledDiffuseColor = texture2D(map, cuv);
        float bl = uBlurPx * band / uPlaneW;
        if (bl > 0.0005) { vec4 acc = sampledDiffuseColor; for (int i = 1; i <= 3; i++) { float o = float(i) / 3.0 * bl;
          acc += texture2D(map, cuv + vec2(o, 0.0)) + texture2D(map, cuv - vec2(o, 0.0)); } sampledDiffuseColor = acc / 7.0; }
        float ch = uChromaPx * band / uPlaneW;
        if (ch > 0.0005) { sampledDiffuseColor.r = texture2D(map, cuv + vec2(ch, 0.0)).r; sampledDiffuseColor.b = texture2D(map, cuv - vec2(ch, 0.0)).b; }
        diffuseColor *= sampledDiffuseColor;`)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n if (uInvert > 0.5) gl_FragColor.rgb = 1.0 - gl_FragColor.rgb;');
  };
  return m;
}

export function createPlayground({ container, titleEl, onIndex, progress }) {
  const reduced = reducedMotion();
  const canvas = document.createElement('canvas'); canvas.setAttribute('aria-hidden', 'true'); container.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, isMobile() ? 1 : 1.25));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.NoToneMapping;             // images shown as authored (original: ACES)
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000);
  const camera = new THREE.OrthographicCamera(-innerWidth / 2, innerWidth / 2, innerHeight / 2, -innerHeight / 2, 1, 1000);
  camera.position.z = 100;

  const textures = [];
  for (let i = 0; i < COUNT; i++) { const t = new THREE.CanvasTexture(makeArt(i)); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; textures.push(t); }
  progress?.(0.5);

  const shared = {
    uBend: { value: 0 }, uBendHalfSize: { value: new THREE.Vector2(innerWidth / 2, innerHeight / 2) }, uBendAxis: { value: new THREE.Vector2(1, 0.25) },
    uBendProfile: { value: FT.bendProfile }, uBendFocal: { value: FT.bendFocal },
    uRes: { value: new THREE.Vector2(1, 1) }, uCover: { value: new THREE.Vector2(1, 1) }, uBlurPx: { value: 0 }, uChromaPx: { value: 0 }, uBand: { value: FT.band }, uPlaneW: { value: 1 },
  };
  const planeGeo = new THREE.PlaneGeometry(1, 1, 24, 24);
  const slides = [-3, -2, -1, 0, 1, 2, 3].map((k) => { const m = new THREE.Mesh(planeGeo, patchedMaterial(textures[0], { shared })); m.userData.k = k; scene.add(m); return m; });
  const honeys = [-3, -2, -1, 0, 1, 2].map(() => { const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), honeyMaterial()); m.position.z = 1; m.visible = false; scene.add(m); return m; });
  const thumbGeo = new THREE.PlaneGeometry(1, 1, 6, 6);
  const thumbs = textures.map((t, i) => {
    const m = new THREE.Mesh(thumbGeo, patchedMaterial(t, { invert: i % 2 === 1, edgeFx: false, shared }));
    m.position.z = 10; m.userData = { i, inspect: { w: 0, x: 0, y: 0 } }; scene.add(m); return m;
  });

  const post = createPostChain(renderer, scene, camera, { ditherMax: 1 });

  // ---------------------------------------------------------------- state
  const S = { current: 0, target: 0, speed: 0, lspeed: 0 };
  let slideW = 0, mode = 'wheel', morph = 0, lastInput = performance.now(), sliderAlpha = 1, dead = false;
  let fxBlur = 0, fxChroma = 0, bend = 0, gap = 0, prevCurrent = 0, keyBoostUntil = 0, lastKey = 0, lastIdx = -1;
  const coarse = isCoarse();

  function resize() {
    const w = innerWidth, h = innerHeight;
    camera.left = -w / 2; camera.right = w / 2; camera.top = h / 2; camera.bottom = -h / 2; camera.updateProjectionMatrix();
    renderer.setSize(w, h, false); post.setSize(w, h);
    slideW = w * (isMobile() ? 0.8 : 0.45);
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    shared.uRes.value.copy(db); shared.uBendHalfSize.value.set(w / 2, h / 2); shared.uPlaneW.value = slideW * renderer.getPixelRatio();
    const pa = slideW / h, ma = 384 / 576;                    // cover-fit: plane vs media aspect
    shared.uCover.value.set(pa > ma ? 1 : pa / ma, pa > ma ? ma / pa : 1);
  }
  addEventListener('resize', resize); addEventListener('orientationchange', resize); resize();

  // ---------------------------------------------------------------- input
  let drag = null;
  const touchInput = () => { lastInput = performance.now(); };
  const onDown = (e) => { if (dialogStack.length) return; drag = { x: e.clientX, y: e.clientY, start: S.target, moved: false, id: e.pointerId, axis: null }; touchInput(); };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (e.pointerType === 'touch' && !drag.axis) { if (Math.hypot(dx, dy) < 8) return; drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; }
    const d = drag.axis === 'y' ? dy : dx;
    if (Math.abs(d) > 3) drag.moved = true;
    const prev = S.target; S.target = drag.start + d * 0.005 * (e.pointerType === 'touch' && isMobile() ? 1.4 : 1);
    S.speed = clamp(S.speed + (S.target - prev) * 2, -1, 1); touchInput(); sound.play('drag');
  };
  const onUp = (e) => {
    if (!drag) return;
    const click = !drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5; drag = null;
    if (click) pickThumb(e.clientX, e.clientY);
  };
  const onWheel = (e) => {
    if (dialogStack.length) return; e.preventDefault(); touchInput();
    const delta = (e.wheelDeltaX || -e.deltaX) + (e.wheelDeltaY || -e.deltaY);
    if (Math.abs(delta) >= 100 && e.deltaMode === 0 && Math.abs(e.deltaY) >= 50) { step(Math.sign(delta)); return; }
    S.target += delta * 0.5 * 0.001; S.speed = clamp(S.speed + delta * 0.5 * 15e-5 * 5, -1, 1); sound.play('drag');
  };
  function step(dir) { const now = performance.now(); if (now - lastKey < 200) return; lastKey = now; keyBoostUntil = now + 700; S.target = Math.round(S.target) + dir; touchInput(); sound.play('drag'); }
  const onKey = (e) => {
    if (dialogStack.length || e.target.closest?.('input, textarea, select, button, [role="dialog"]')) return;
    if (['ArrowLeft', 'a', 'A'].includes(e.key)) { step(1); e.preventDefault(); }
    else if (['ArrowRight', 'd', 'D', ' '].includes(e.key)) { step(-1); e.preventDefault(); }
  };
  container.addEventListener('pointerdown', onDown);
  addEventListener('pointermove', onMove, { passive: true }); addEventListener('pointerup', onUp);
  container.addEventListener('wheel', onWheel, { passive: false }); addEventListener('keydown', onKey);

  const raycaster = new THREE.Raycaster();
  function pickThumb(x, y) {
    raycaster.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
    const hit = raycaster.intersectObjects(thumbs)[0];
    if (hit) inspect(hit.object);
  }
  /** Tween #25: fly to centre ×3 (1.2 s power4.out), hold 800 ms, back (1 s power3.inOut). */
  function inspect(t) {
    const st = t.userData.inspect; if (st.busy) return; st.busy = true;
    sound.play('click');
    thumbs.forEach((o) => { o.position.z = o === t ? 20 : 10; });
    const d = reduced ? 0.01 : 1;
    gsap.to(st, { w: 1, duration: 1.2 * d, ease: 'power4.out', onComplete: () => {
      gsap.to(st, { w: 0, duration: 1 * d, delay: 0.8, ease: 'power3.inOut', onComplete: () => { st.busy = false; } });
    } });
  }

  function setMode(m) { mode = m; sound.play('click'); touchInput(); }

  // ---------------------------------------------------------------- frame
  const clock = new THREE.Clock();
  function tick() {
    if (dead) return;
    const dt = Math.min(clock.getDelta(), 0.1);
    S.speed = clamp(S.speed * Math.pow(0.95, 2 * dt * 60), -1, 1);
    S.lspeed += ((coarse ? 0 : Math.abs(S.speed)) - S.lspeed) * damp(0.1, dt);
    if (!drag) S.target += (Math.round(S.target) - S.target) * damp(0.1, dt);
    S.current += (S.target - S.current) * damp(performance.now() < keyBoostUntil ? 0.08 : coarse ? 0.12 : 0.04, dt);

    const vel = (S.current - prevCurrent) / Math.max(dt, 1e-4); prevCurrent = S.current;
    const speedPx = Math.abs(vel) * slideW;
    const fxT = reduced ? 0 : Math.min(1, speedPx / 3000);
    fxBlur = approach(fxBlur, fxT * FT.blurMax, fxT * FT.blurMax > fxBlur ? FT.attack : FT.release, dt);
    fxChroma = approach(fxChroma, fxT * FT.chroma, fxT * FT.chroma > fxChroma ? FT.attack : FT.release, dt);
    const tb = reduced ? 0 : Math.min((speedPx * FT.bendStrength) / 1000, FT.bendMaxPx);
    bend = approach(bend, tb, tb > bend ? FT.bendAttack : FT.bendRelease, dt);
    const tg = reduced ? 0 : Math.min(FT.maxGapExpansion, (speedPx / 1000) * FT.gapSpeedStrength);
    gap = approach(gap, tg, tg > gap ? FT.attack : FT.release, dt);
    const pr = renderer.getPixelRatio();
    shared.uBlurPx.value = fxBlur * pr; shared.uChromaPx.value = fxChroma * pr; shared.uBend.value = -bend;

    // idle: title fades after 2 s, slider fades toward the thumbnail layer (Ce lerp at 4/s)
    const idle = performance.now() - lastInput > 2000;
    titleEl?.classList.toggle('is-idle', idle);
    sliderAlpha = approach(sliderAlpha, idle ? 0.35 : 1, 4, dt);

    const h = innerHeight, base = Math.round(-S.current);
    for (const m of slides) {
      const v = base + m.userData.k, off = v + S.current;
      m.material.map = textures[mod(v, COUNT)];
      m.position.set(off * (slideW + gap), 0, 0); m.scale.set(slideW, h, 1);
      m.material.opacity = sliderAlpha;
    }
    // honey bridges in the gaps
    honeys.forEach((hm, idx) => {
      const k = idx - 3, v = base + k, off = v + S.current;
      hm.visible = gap > 2;
      if (!hm.visible) return;
      const x0 = off * (slideW + gap) + slideW / 2;
      hm.position.set(x0 + gap / 2, 0, 1); hm.scale.set(gap, h, 1);
      const u = hm.material.uniforms;
      u.uTexA.value = textures[mod(v, COUNT)]; u.uTexB.value = textures[mod(v + 1, COUNT)];
      u.uHeight.value = h; u.hA.value = h; u.hB.value = h;
      u.uPinch.value = FT.honeyPinch - 0.55 * Math.min(1, gap / FT.maxGapExpansion);   // neck narrows as the gap opens
      u.uPinchPos.value = 0.5 + clamp(vel * FT.honeyLag, -0.4, 0.4);
      u.uCoverA.value.copy(shared.uCover.value); u.uOpacity.value = sliderAlpha;
    });

    // wheel ↔ grid morph
    morph += ((mode === 'grid' ? 1 : 0) - morph) * damp(0.08, dt);
    const mob = isMobile(), R = mob ? 150 : 300, tw = mob ? 30 : 70, th = mob ? 45 : 100;
    const stripY = -(mob ? innerHeight / 4 : 260), spacing = (mob ? 80 : 160) * (1 + S.lspeed * 0.5);
    const scroll = S.current * slideW;
    thumbs.forEach((t) => {
      const i = t.userData.i, st = t.userData.inspect;
      const a = (i * Math.PI * 2) / COUNT + scroll * 0.0015;
      const wx = Math.cos(a) * R, wy = Math.sin(a) * R, wr = a + Math.PI / 2;
      const gx = (mod(i + S.current + COUNT / 2, COUNT) - COUNT / 2) * spacing, gy = stripY;
      let x = wx + (gx - wx) * morph, y = wy + (gy - wy) * morph, r = wr * (1 - morph), s = 1;
      if (st.w > 0) { x *= 1 - st.w; y *= 1 - st.w; r *= 1 - st.w; s = 1 + 2 * st.w; }
      t.position.x = x; t.position.y = y; t.rotation.z = r; t.scale.set(tw * s, th * s, 1);
    });

    const idx = mod(base, COUNT);
    if (idx !== lastIdx) { lastIdx = idx; onIndex?.(idx, TITLES[idx % TITLES.length]); }
    post.render(dt);
  }

  const ready = (async () => {
    try { await renderer.compileAsync(scene, camera); } catch { renderer.compile(scene, camera); }
    textures.forEach((t) => renderer.initTexture(t));
    progress?.(1);
    renderer.setAnimationLoop(tick);
  })();

  return {
    ready, setMode,
    get mode() { return mode; },
    startIntro() { if (reduced) return; S.current = S.target + 5; S.speed = 5; },
    destroy() {
      dead = true; renderer.setAnimationLoop(null);
      removeEventListener('resize', resize); removeEventListener('orientationchange', resize);
      removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); removeEventListener('keydown', onKey);
      thumbs.forEach((t) => gsap.killTweensOf(t.userData.inspect));
      [...slides, ...thumbs, ...honeys].forEach((m) => m.material.dispose());
      textures.forEach((t) => t.dispose()); planeGeo.dispose(); thumbGeo.dispose(); honeys.forEach((hm) => hm.geometry.dispose());
      post.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    },
  };
}
