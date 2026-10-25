// three/post.js — shared post chain helpers: dither + GlitchPass + OutputPass, driven by
// the navbar logo toggle (design-notes §4.8, tween #12).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GlitchPass } from 'three/addons/postprocessing/GlitchPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { DitherShader } from './shaders.js';
import { gsap } from '../core/gsap.js';
import { on, reducedMotion, isMobile } from '../core/env.js';
import { fxState } from '../core/fx.js';

/**
 * createPostChain(renderer, scene, camera, { main: [passes before dither], after: [passes after glitch], ditherMax })
 * Order: RenderPass → main… → Dither → Glitch → after… → Output
 * Output is enabled only when the main pass is not last (dither/glitch/after active), because
 * the lens / composite shaders already include <tonemapping_fragment> + <colorspace_fragment>.
 */
export function createPostChain(renderer, scene, camera, { main = [], after = [], ditherMax = 1, outputAlways = false } = {}) {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  main.forEach((p) => composer.addPass(p));
  const dither = new ShaderPass(DitherShader);
  dither.uniforms.uPixelSizeRatio.value = isMobile() ? 2.8 : 2;
  dither.enabled = false;
  composer.addPass(dither);
  const glitch = new GlitchPass(); glitch.enabled = false; glitch.goWild = true;
  composer.addPass(glitch);
  after.forEach((p) => composer.addPass(p));
  const output = new OutputPass();
  composer.addPass(output);

  let glitchTimer = 0;
  const apply = (onFx, instant = false) => {
    const target = onFx ? ditherMax : 0;
    gsap.killTweensOf(dither.uniforms.uIntensity);
    if (onFx) dither.enabled = true;
    gsap.to(dither.uniforms.uIntensity, {
      value: target, duration: instant ? 0 : 0.8, ease: 'power2.inOut',
      onComplete: () => { if (!onFx) dither.enabled = false; },
    });
    if (onFx && !instant && !reducedMotion()) {           // 600 ms GlitchPass "goWild" burst
      glitch.enabled = true; clearTimeout(glitchTimer);
      glitchTimer = setTimeout(() => { glitch.enabled = false; }, 600);
    }
  };
  if (fxState.on) apply(true, true);
  const off = on('fx', (v) => apply(v));

  return {
    composer, dither, glitch, output,
    setSize(w, h) {
      composer.setSize(w, h);
      const s = renderer.getDrawingBufferSize(new THREE.Vector2());
      dither.uniforms.uResolution.value.copy(s);
    },
    setPixelRatio(r) { composer.setPixelRatio(r); },
    render(dt) {
      output.enabled = outputAlways || dither.enabled || glitch.enabled || after.some((p) => p.enabled);
      composer.render(dt);
    },
    dispose() { off(); clearTimeout(glitchTimer); composer.dispose(); rt.dispose(); dither.material.dispose(); },
  };
}

export { ShaderPass };
