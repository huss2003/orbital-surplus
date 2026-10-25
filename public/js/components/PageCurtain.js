// components/PageCurtain.js — RevealOverlay, the "dither curtain" (design-notes §4.1).
//
// A fixed full-screen canvas at z 9999, pixel ratio 1, drawing one full-screen
// triangle with the original's shader logic: animated Perlin noise + a distance
// "hole" that opens from the centre, thresholded by an 8×8 Bayer matrix, with a
// red fringe band at the hole edge and dither cells that grow 2→4→8px toward the
// screen edges. uProgress: 0 = fully covered (white), 1 = fully open.
//
// Raw WebGL (not three) so the curtain still works when the three CDN is down.
// Reduced motion / no WebGL → a plain white <div> that fades (.3s).
import { gsap } from '../core/gsap.js';
import { reducedMotion } from '../core/env.js';

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
uniform vec2 uResolution; uniform float uProgress, uTime, uCell, uLevels, uCurve;
uniform vec3 uColorMain, uColorLight, uFringe;
// Classic Perlin 3D noise (Stefan Gustavson)
vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
vec3 fade(vec3 t){ return t*t*t*(t*(t*6.0-15.0)+10.0); }
float cnoise(vec3 P){
  vec3 Pi0 = floor(P), Pi1 = Pi0 + vec3(1.0); Pi0 = mod(Pi0, 289.0); Pi1 = mod(Pi1, 289.0);
  vec3 Pf0 = fract(P), Pf1 = Pf0 - vec3(1.0);
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x), iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz, iz1 = Pi1.zzzz;
  vec4 ixy = permute(permute(ix) + iy), ixy0 = permute(ixy + iz0), ixy1 = permute(ixy + iz1);
  vec4 gx0 = ixy0 / 7.0, gy0 = fract(floor(gx0) / 7.0) - 0.5; gx0 = fract(gx0);
  vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0), sz0 = step(gz0, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5); gy0 -= sz0 * (step(0.0, gy0) - 0.5);
  vec4 gx1 = ixy1 / 7.0, gy1 = fract(floor(gx1) / 7.0) - 0.5; gx1 = fract(gx1);
  vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1), sz1 = step(gz1, vec4(0.0));
  gx1 -= sz1 * (step(0.0, gx1) - 0.5); gy1 -= sz1 * (step(0.0, gy1) - 0.5);
  vec3 g000 = vec3(gx0.x,gy0.x,gz0.x), g100 = vec3(gx0.y,gy0.y,gz0.y), g010 = vec3(gx0.z,gy0.z,gz0.z), g110 = vec3(gx0.w,gy0.w,gz0.w);
  vec3 g001 = vec3(gx1.x,gy1.x,gz1.x), g101 = vec3(gx1.y,gy1.y,gz1.y), g011 = vec3(gx1.z,gy1.z,gz1.z), g111 = vec3(gx1.w,gy1.w,gz1.w);
  vec4 n0 = taylorInvSqrt(vec4(dot(g000,g000), dot(g010,g010), dot(g100,g100), dot(g110,g110)));
  g000 *= n0.x; g010 *= n0.y; g100 *= n0.z; g110 *= n0.w;
  vec4 n1 = taylorInvSqrt(vec4(dot(g001,g001), dot(g011,g011), dot(g101,g101), dot(g111,g111)));
  g001 *= n1.x; g011 *= n1.y; g101 *= n1.z; g111 *= n1.w;
  float n000 = dot(g000, Pf0), n100 = dot(g100, vec3(Pf1.x, Pf0.yz)), n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z)), n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z)), n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z)), n011 = dot(g011, vec3(Pf0.x, Pf1.yz)), n111 = dot(g111, Pf1);
  vec3 fxyz = fade(Pf0);
  vec4 nz = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fxyz.z);
  vec2 nyz = mix(nz.xy, nz.zw, fxyz.y);
  return 2.2 * mix(nyz.x, nyz.y, fxyz.x);
}
// 8×8 ordered dither via recursive 2×2 Bayer
float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(vec2 a){ return bayer4(0.5 * a) * 0.25 + bayer2(a); }
void main(){
  float pixD = distance(gl_FragCoord.xy / uResolution, vec2(0.5)) / 0.7071;
  // variant 3: cell size grows toward the edges in powers of two (2, 4, 8 px)
  float t = min(pow(pixD, uCurve), 0.999);
  float size = uCell * exp2(floor(t * (uLevels + 1.0)));
  vec2 cell = floor(gl_FragCoord.xy / size);
  vec2 cellUv = (cell + 0.5) * size / uResolution;
  float strength = cnoise(vec3(cellUv * 3.0, uTime * 0.2));             // animated Perlin
  float hole = distance(cellUv, vec2(0.5)) * 10.0 - uProgress * 12.0 + 2.5; // hole opens from centre
  strength += hole;
  float threshold = bayer8(cell) * 0.9375 + 0.03;                          // ordered dither
  float white = step(threshold, clamp(strength, 0.0, 1.0));
  float reach = 0.55 * (1.0 - smoothstep(0.8, 1.0, uProgress));
  float fringe = step(threshold, strength + reach) * (1.0 - white);       // red edge band
  vec3 body = mix(uColorMain, uColorLight, 1.0);
  float a = max(white, fringe);
  gl_FragColor = vec4(mix(uFringe, body, white) * a, a);                  // premultiplied
}`;

const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

export function createPageCurtain() {
  const state = { value: 0 };           // start covered
  let gl = null, prog = null, U = {}, raf = 0, t0 = performance.now();
  let el;
  const useCss = reducedMotion();

  if (!useCss) {
    el = document.createElement('canvas');
    el.className = 'curtain is-pending';
    try { gl = el.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false }); } catch { gl = null; }
  }
  if (gl) {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    try {
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog); gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      for (const n of ['uResolution', 'uProgress', 'uTime', 'uCell', 'uLevels', 'uCurve', 'uColorMain', 'uColorLight', 'uFringe']) U[n] = gl.getUniformLocation(prog, n);
      gl.uniform1f(U.uCell, 2); gl.uniform1f(U.uLevels, 2); gl.uniform1f(U.uCurve, 3);
      gl.uniform3fv(U.uColorMain, hex('#C8FF2E')); gl.uniform3fv(U.uColorLight, [1, 1, 1]); gl.uniform3fv(U.uFringe, hex('#C8FF2E'));
    } catch (e) { console.warn('[curtain] shader failed, CSS fallback', e); gl = null; }
  }
  if (!gl) { el = document.createElement('div'); el.className = 'curtain curtain--css'; }
  el.setAttribute('aria-hidden', 'true');

  function resize() {
    if (!gl) return;
    el.width = innerWidth; el.height = innerHeight;     // pixel ratio 1: meant to look pixelated
    gl.viewport(0, 0, el.width, el.height);
  }
  function draw() {
    if (!gl) { el.style.opacity = String(1 - state.value); el.classList.toggle('is-open', state.value >= 0.999); return; }
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(U.uResolution, el.width, el.height);
    gl.uniform1f(U.uProgress, state.value);
    gl.uniform1f(U.uTime, (performance.now() - t0) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    el.classList.remove('is-pending');
  }
  function tick() {
    raf = 0;
    const open = state.value >= 0.999;
    el.classList.toggle('is-open', open);
    if (open) return;               // stop rendering once fully open
    draw();
    raf = requestAnimationFrame(tick);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };
  addEventListener('resize', () => { resize(); kick(); });

  return {
    el,
    mount(parent = document.body) { parent.append(el); resize(); kick(); },
    get value() { return state.value; },
    set(v) { gsap.killTweensOf(state); state.value = v; el.classList.toggle('is-open', v >= 0.999); kick(); if (!gl) draw(); },
    /** Tween uProgress. Returns a promise. */
    to(value, { duration, ease }) {
      gsap.killTweensOf(state);
      el.classList.remove('is-open');
      kick();
      return new Promise((resolve) => {
        gsap.to(state, { value, duration: useCss ? Math.min(duration, 0.3) : duration, ease, onUpdate: () => { kick(); if (!gl) draw(); }, onComplete: () => { kick(); if (!gl) draw(); resolve(); } });
      });
    },
  };
}
