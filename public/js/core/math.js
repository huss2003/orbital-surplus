// core/math.js — damp / lerp utilities and the critically-damped Damper.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const mod = (n, m) => ((n % m) + m) % m;

/**
 * Frame-rate-independent lerp factor (design-notes §4.3 / 3d-ar-notes §1.3):
 *   fr(f, dt) = 1 - (1 - f)^(dt * 60)
 * `f` is "how much per 60fps frame"; the result is correct at any refresh rate.
 */
export const damp = (f, dt) => 1 - Math.pow(1 - f, dt * 60);

/** Exponential attack/release smoothing: x += (target - x) * (1 - e^(-k dt)). */
export const approach = (x, target, k, dt) => x + (target - x) * (1 - Math.exp(-k * dt));

/** Wrap an angle to [-PI, PI]. */
export const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Critically-damped spring — the same "Damper" model-viewer uses, as copied by the
 * original ARViewer (3d-ar-notes §3.2). decayMs = time constant.
 */
export class Damper {
  constructor(decayMs = 50) { this.v = 0; this.w = 1 / Math.max(1e-3, decayMs); }
  update(x, goal, dtMs, norm) {
    const eps = 2e-4 * this.w;
    if (x === goal && this.v === 0) return goal;
    if (dtMs < 0) return x;
    const d = x - goal;
    const a = this.v + this.w * d;
    const b = d + dtMs * a;
    const e = Math.exp(-this.w * dtMs);
    const v = (a - this.w * b) * e;
    const acc = -this.w * (v + a * e);
    if (Math.abs(v) < eps * Math.abs(norm) && acc * d >= 0) { this.v = 0; return goal; }
    this.v = v;
    return goal + b * e;
  }
}
