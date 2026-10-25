// components/NotFound.js — 404: HomeSlider in notFound mode (one jacket at 10 % opacity,
// permanently blurred, input disabled), ghost "404 PAGE / NOT FOUND" above it,
// [RETURN TO VAULT] at top 75 %, nav links struck through (design-notes §2 404).
import { mount as mountHome } from './HomePage.js';

export function mount(root, route, ctx) {
  return mountHome(root, route, ctx, { notFound: true });
}
