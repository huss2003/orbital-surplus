// components/PlaygroundPage.js — /playground (design-notes §2 Playground): title `// NAME`
// in DM Mono 700 with a red `//`, WHEEL / GRID toggle fixed at top 90px / right 40px.
import { h } from '../core/dialog.js';
import { ScrambleText } from '../core/ScrambleText.js';
import { loadScene } from './Fallback.js';

export async function mount(root, route, ctx) {
  document.title = 'Playground — ORBITAL SURPLUS';
  ctx.progress?.data(1);
  const stage = h('div', { class: 'stage' });
  const titleText = new ScrambleText('PIXEL DREAMS', { hover: false });
  const title = h('p', { class: 'pg-title', 'aria-live': 'polite' }, h('span', { class: 'sl', 'aria-hidden': 'true' }, '// '), titleText.el);
  const wheelBtn = h('button', { type: 'button', 'aria-pressed': 'true' }, 'WHEEL');
  const gridBtn = h('button', { type: 'button', 'aria-pressed': 'false' }, 'GRID');
  const toggle = h('div', { class: 'pg-toggle', role: 'group', 'aria-label': 'Thumbnail layout' }, wheelBtn, gridBtn);
  const main = h('main', { id: 'main', tabindex: '-1' }, h('h1', { class: 'sr-only' }, 'Playground — a WebGL image gallery. Use the arrow keys to browse.'));
  root.append(stage, title, toggle, main);

  const Scene = await loadScene('Playground');
  let scene = null;
  if (Scene) {
    try {
      scene = Scene.createPlayground({ container: stage, titleEl: title, progress: (f) => ctx.progress?.scene(f), onIndex: (i, t) => titleText.setText(t) });
    } catch (err) { console.warn('[playground] WebGL init failed', err); }
  }
  if (!scene) {
    ctx.progress?.scene(1);
    // static fallback: the generated artwork as plain canvases → images
    const grid = h('div', { class: 'fallback' });
    let makeArt = null;
    try { ({ makeArt } = await import('../scenes/Playground.js')); } catch { /* three missing */ }
    for (let i = 0; i < 4; i++) {
      if (makeArt) { const c = makeArt(i, 192, 288); c.style.width = 'min(20vw, 192px)'; c.style.height = 'auto'; c.setAttribute('role', 'img'); c.setAttribute('aria-label', `Artwork ${i + 1}`); grid.append(c); }
      else grid.append(h('img', { src: ['/img/perigee-moto-jacket-front.png', '/img/reentry-puffer-front.png', '/img/tether-shell-front.png', '/img/drift-coach-jacket-front.png'][i % 4], alt: '' }));
    }
    stage.append(grid);
  }
  const set = (m) => { scene?.setMode(m); wheelBtn.setAttribute('aria-pressed', String(m === 'wheel')); gridBtn.setAttribute('aria-pressed', String(m === 'grid')); };
  wheelBtn.addEventListener('click', () => set('wheel'));
  gridBtn.addEventListener('click', () => set('grid'));

  return {
    ready: scene ? scene.ready : Promise.resolve(),
    enter() { scene?.startIntro(); },
    destroy() { scene?.destroy(); titleText.stop(); },
  };
}
