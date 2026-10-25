// three/shaders.js — ShaderPass definitions transcribed from 3d-ar-notes §1.4–1.6
// and design-notes §2/§4.4. Values in `uniforms` are the documented ones.
import * as THREE from 'three';

const VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const HASH = /* glsl */`float hash(vec2 p){ return fract(1e4 * sin(17.0 * p.x + p.y * 0.1) * (0.1 + abs(sin(p.y * 13.0 + p.x)))); }`;

/** Shop lens pass: barrel distortion + radial blur + edge chroma + 1-bit grain + vignette (§1.4). */
export const LensShader = {
  name: 'LensShader',
  uniforms: {
    tDiffuse: { value: null },
    distortionStrength: { value: -0.38 }, principalPoint: { value: new THREE.Vector2(0.5, 0.5) },
    strength: { value: 0.1 }, center: { value: new THREE.Vector2(0.5, 0.5) }, samples: { value: 4 },
    uTime: { value: 0 }, timeStrength: { value: 0.41 },
    uIntensity: { value: 2 }, uRadius: { value: 0.29 }, uSmoothness: { value: 1 }, uVignetteEnabled: { value: true },
    uChromaIntensity: { value: 0.58 }, uChromaRadius: { value: 0.2 }, uChromaSmoothness: { value: 1 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float distortionStrength; uniform vec2 principalPoint;
    uniform float strength; uniform vec2 center; uniform int samples; uniform float uTime, timeStrength;
    uniform float uIntensity, uRadius, uSmoothness; uniform bool uVignetteEnabled;
    uniform float uChromaIntensity, uChromaRadius, uChromaSmoothness; varying vec2 vUv;
    ${HASH}
    vec2 distort(vec2 p){ vec2 uv = p - principalPoint; uv *= 1.0 + distortionStrength * dot(uv, uv); return uv + principalPoint; }
    vec4 sampleDistorted(vec2 p){ vec2 uv = distort(p); if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0); return texture2D(tDiffuse, uv); }
    void main(){
      vec2 dir = vUv - center; vec4 blur = vec4(0.0); float n = 0.0;
      for (int i = 0; i < 16; i++) { if (i >= samples) break; float t = float(i) / float(samples);
        blur += sampleDistorted(vUv - dir * t * strength * 0.1); n += 1.0; }
      blur /= n;
      float chromaMask = smoothstep(uChromaRadius, uChromaRadius + uChromaSmoothness, distance(vUv, vec2(0.5)));
      float off = chromaMask * uChromaIntensity * 0.01; vec3 col = blur.rgb;
      if (off > 0.0001) { col.r = sampleDistorted(vUv + vec2(off, 0.0)).r; col.b = sampleDistorted(vUv - vec2(off, 0.0)).b; }
      float bw = step(0.5, hash(vUv + mod(uTime, 100.0) * timeStrength)); col = mix(col, vec3(bw), 0.025);
      float a = blur.a;
      if (uVignetteEnabled) { float m = smoothstep(uRadius, uRadius + uSmoothness, distance(vUv, center));
        float v = 1.0 - m * uIntensity; col *= v; a = max(a, clamp(1.0 - v, 0.15, 1.0)); }
      gl_FragColor = vec4(col, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

/** Ripple "zoom-through" transition on jacket click; uProgress -0.1 → 2.5 over 1.8 s (§1.4). */
export const RippleShader = {
  name: 'RippleShader',
  uniforms: {
    tDiffuse: { value: null }, uCenter: { value: new THREE.Vector2(0.5, 0.5) }, uResolution: { value: new THREE.Vector2(1, 1) },
    uProgress: { value: -0.1 }, uWidth: { value: 0.35 }, uRadius: { value: 0.9 }, uTime: { value: 0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 uCenter, uResolution; uniform float uProgress, uWidth, uRadius, uTime; varying vec2 vUv;
    ${HASH}
    float noise(vec2 x){ vec2 i = floor(x), f = fract(x); vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
    void main(){
      vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
      float prog = uProgress * 0.66 + noise(vUv * 10.0 + uTime * 0.5) * 0.04;
      float dist = distance(uCenter * aspect, vUv * aspect);
      float circ = 1.0 - smoothstep(-uWidth, 0.0, uRadius * dist - prog * (1.0 + uWidth));
      vec4 t1 = texture2D(tDiffuse, (vUv - 0.5) * (1.0 - circ) + 0.5);
      vec4 t2 = texture2D(tDiffuse, (vUv - 0.5) * circ + 0.5);
      gl_FragColor = mix(t1, t2, circ);
    }`,
};

/** Bayer 4×4 dither / pixelate, toggled by the logo (§1.4, design-notes §4.8). */
export const DitherShader = {
  name: 'DitherShader',
  uniforms: {
    tDiffuse: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) },
    uGridSize: { value: 2 }, uPixelSizeRatio: { value: 2 }, uIntensity: { value: 0 }, uInvertColor: { value: 0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform vec2 uResolution; uniform float uGridSize, uPixelSizeRatio, uIntensity, uInvertColor; varying vec2 vUv;
    float bayerT(vec2 p){
      int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0)); float v;
      if (y == 0) v = x == 0 ? 16.0 : x == 1 ? 5.0 : x == 2 ? 13.0 : 1.0;
      else if (y == 1) v = x == 0 ? 8.0 : x == 1 ? 12.0 : x == 2 ? 4.0 : 9.0;
      else if (y == 2) v = x == 0 ? 14.0 : x == 1 ? 2.0 : x == 2 ? 15.0 : 3.0;
      else v = x == 0 ? 6.0 : x == 1 ? 10.0 : x == 2 ? 7.0 : 11.0;
      return v / 17.0;
    }
    void main(){
      vec4 original = texture2D(tDiffuse, vUv);
      vec2 fragCoord = gl_FragCoord.xy;
      float pixelSize = uGridSize * uPixelSizeRatio;
      vec4 baseS = texture2D(tDiffuse, floor(fragCoord / pixelSize) * pixelSize / uResolution);
      vec3 base = baseS.rgb;
      float lum = dot(base, vec3(1.0));                 // sum of RGB, as in the original
      bool black = lum < bayerT(floor(fragCoord / uGridSize));
      vec3 c = black ? vec3(0.0) : base; if (uInvertColor > 0.0) c = 1.0 - c;
      gl_FragColor = vec4(mix(original.rgb, c, uIntensity), max(original.a, baseS.a * uIntensity));
    }`,
};

/**
 * Home composite: front (solid turntable) vs greyscale wireframe through a cursor-following
 * SQUARE (Chebyshev) mask (design-notes §4.4), scan pulse, speed-driven top/bottom edge
 * blur + chroma (§4.3, 22.5% bands), grain + vignette (§2 Home: strength .1, grain .025,
 * vignette intensity 2, radius .29, smoothness 1). Includes tone mapping when it is last.
 */
export const HomeCompositeShader = {
  name: 'HomeCompositeShader',
  uniforms: {
    tDiffuse: { value: null }, tWire: { value: null }, uResolution: { value: new THREE.Vector2(1, 1) },
    uMouse: { value: new THREE.Vector2(-1, -1) }, uSize: { value: 0 }, uSmoothness: { value: 0.01 }, uStrength: { value: 0 },
    uBackBrightness: { value: 1.2 }, uTime: { value: 0 }, uPulse: { value: 1 },
    uBand: { value: 0.225 }, uBlurPx: { value: 0 }, uChromaPx: { value: 0 },
    uNoise: { value: 0.1 }, uGrain: { value: 0.025 }, uVIntensity: { value: 2 }, uVRadius: { value: 0.29 }, uVSmooth: { value: 1 },
    uOpacity: { value: 1 }, uBlur: { value: 0 },
  },
  vertexShader: VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tWire; uniform vec2 uResolution, uMouse;
    uniform float uSize, uSmoothness, uStrength, uBackBrightness, uTime, uPulse, uBand, uBlurPx, uChromaPx;
    uniform float uNoise, uGrain, uVIntensity, uVRadius, uVSmooth, uOpacity, uBlur; varying vec2 vUv;
    ${HASH}
    vec4 tap(vec2 uv){ return texture2D(tDiffuse, clamp(uv, vec2(0.001), vec2(0.999))); }
    void main(){
      vec2 px = 1.0 / uResolution;
      float band = max(smoothstep(uBand, 0.0, vUv.y), smoothstep(1.0 - uBand, 1.0, vUv.y));
      float blurR = uBlurPx * band + uBlur;
      vec4 front = tap(vUv);
      if (blurR > 0.5) {                                    // cheap 9-tap vertical/radial blur
        vec4 acc = front; float w = 1.0;
        for (int i = 1; i <= 4; i++) { float o = float(i) / 4.0 * blurR;
          acc += tap(vUv + vec2(0.0, o) * px) + tap(vUv - vec2(0.0, o) * px); w += 2.0;
          if (uBlur > 0.5) { acc += tap(vUv + vec2(o, 0.0) * px) + tap(vUv - vec2(o, 0.0) * px); w += 2.0; } }
        front = acc / w;
      }
      float ch = uChromaPx * band;
      if (ch > 0.2) { front.r = tap(vUv + vec2(0.0, ch) * px).r; front.b = tap(vUv - vec2(0.0, ch) * px).b; }

      // square reveal window (sizes in px): max(|dx|,|dy|), not a circle
      vec2 d = abs(gl_FragCoord.xy - uMouse);
      float dist = max(d.x, d.y);
      float sizePx = uSize; float smoothPx = uSmoothness * uResolution.y;
      float mask = smoothstep(sizePx - smoothPx, sizePx, dist);
      vec4 w = texture2D(tWire, vUv);
      vec3 back = vec3(dot(w.rgb, vec3(0.299, 0.587, 0.114))) * uBackBrightness;
      vec3 revealed = mix(back, front.rgb, mask);
      vec3 col = mix(front.rgb, revealed, uStrength);
      float a = max(front.a, (1.0 - mask) * uStrength);

      // scan pulse: a light band moving up, masked to the jacket's luma
      float lum = dot(front.rgb, vec3(0.299, 0.587, 0.114));
      float pb = 1.0 - smoothstep(0.0, 0.1, abs(vUv.y - fract(uTime * 0.5)));
      float flick = 0.7 + 0.3 * step(0.5, hash(vec2(floor(uTime * 24.0), 3.0)));
      col += vec3(pb * 0.6 * flick * smoothstep(0.05, 0.4, lum) * 0.35) * uPulse;

      // noise + 1-bit grain + vignette
      float n = hash(vUv * uResolution.xy * 0.01 + mod(uTime, 100.0));
      col += (n - 0.5) * uNoise * 0.2;
      col = mix(col, vec3(step(0.5, n)), uGrain);
      float m = smoothstep(uVRadius, uVRadius + uVSmooth, distance(vUv, vec2(0.5)));
      float v = 1.0 - m * uVIntensity; col *= max(v, 0.0); a = max(a * uOpacity, clamp(1.0 - v, 0.15, 1.0));
      gl_FragColor = vec4(col * uOpacity, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

/** Faint world-space line grid behind the shop jackets: fwidth AA lines, spacing 3.5, opacity .06 (§1.5). */
export function gridMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uSpacing: { value: 3.5 }, uOpacity: { value: 0.06 }, uOffset: { value: new THREE.Vector2() } },
    vertexShader: /* glsl */`varying vec2 vP; uniform vec2 uOffset; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vP = wp.xy - uOffset; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */`varying vec2 vP; uniform float uSpacing, uOpacity;
      void main(){ vec2 g = (vP + uSpacing * 0.5) / uSpacing; vec2 f = abs(fract(g - 0.5) - 0.5) / fwidth(g);
        float line = 1.0 - min(min(f.x, f.y), 1.0); gl_FragColor = vec4(vec3(1.0), line * uOpacity); }`,
  });
}

/** Wireframe overlay: vertex shimmer + screen-space trail-RT mask (§1.5). */
export function wireMaterial(trailMap) {
  return new THREE.ShaderMaterial({
    transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xffffff) }, uTrailMap: { value: trailMap }, uResolution: { value: new THREE.Vector2(1, 1) }, uOpacity: { value: 0.9 }, uShowTrail: { value: 0 } },
    vertexShader: /* glsl */`uniform float uTime; varying vec3 vWorldPosition;
      void main(){ vec4 wp = modelMatrix * vec4(position, 1.0);
        wp.xyz += vec3(sin(uTime * 16.0 + position.y * 15.0), cos(uTime * 15.0 + position.x * 15.0), sin(uTime * 16.0 + position.z * 15.0)) * 0.001;
        vWorldPosition = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */`uniform vec3 uColor; uniform sampler2D uTrailMap; uniform vec2 uResolution; uniform float uOpacity, uShowTrail;
      void main(){ float m = texture2D(uTrailMap, gl_FragCoord.xy / uResolution).r;
        float a = m * uOpacity * uShowTrail; if (a < 0.01) discard; gl_FragColor = vec4(uColor, a); }`,
  });
}

/** Soft white radial sprite used by the cursor trail (64 px CanvasTexture). */
export function radialSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/**
 * Bend vertex chunk (§1.6), injected into MeshBasicMaterial by replacing <project_vertex>.
 * uBend < 0 pushes the centre away (fake perspective in an ortho camera).
 */
export const BEND_UNIFORMS = /* glsl */`uniform float uBend; uniform vec2 uBendHalfSize, uBendAxis; uniform float uBendProfile, uBendFocal;\n`;
export const BEND_CHUNK = /* glsl */`
  vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
  vec2 bn = mvPosition.xy / uBendHalfSize;
  float r2 = clamp(dot(bn * bn, uBendAxis), 0.0, 1.0);
  float depth = uBend * (1.0 - pow(r2, uBendProfile * 0.5));
  depth = max(depth, -0.9 * uBendFocal);
  mvPosition.xy *= uBendFocal / (uBendFocal + depth);
  gl_Position = projectionMatrix * mvPosition;
`;
