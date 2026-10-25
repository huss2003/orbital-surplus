// core/dprGovernor.js — adaptive DPR governor (3d-ar-notes §1.7, `L()` in chunk-C2x8EAbL.js).
// Samples fps in 0.5 s windows; after 1.5 s below `slowFps` it lowers the pixel ratio by
// `step`, waits 1 s, repeats. Only ever lowers, never raises. Ignores >250 ms hitches.
export function dprGovernor({ max, min, step = 0.25, slowFps = 50, slowSeconds = 1.5, apply }) {
  let ratio = max, frames = 0, acc = 0, slowFor = 0, cooldown = 0;
  return {
    get ratio() { return ratio; },
    frame(dt) {
      if (ratio <= min) return;
      if (dt > 0.25) { frames = acc = 0; return; }            // tab switch / hitch
      if (cooldown > 0) { cooldown -= dt; return; }
      frames++; acc += dt;
      if (acc < 0.5) return;
      slowFor = frames / acc < slowFps ? slowFor + acc : 0;
      frames = acc = 0;
      if (slowFor >= slowSeconds) {
        ratio = Math.max(min, ratio - step); slowFor = 0; cooldown = 1;
        apply(ratio);
      }
    },
  };
}
