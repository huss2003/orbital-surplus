// server/images.js
// Generated SVGs: the app icon / logo used by the web manifest and JSON-LD.
// Product photos are real PNG renders of the procedural 3D jackets in public/img/.

/** Pixel "orbit" mark on black, lime satellite. */
function iconSvg() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512" shape-rendering="crispEdges">
  <rect width="64" height="64" fill="#000"/>
  <g fill="#e8e8e8"><rect x="20" y="18" width="16" height="4"/><rect x="16" y="22" width="4" height="4"/><rect x="36" y="22" width="4" height="4"/><rect x="12" y="26" width="4" height="4"/><rect x="40" y="26" width="4" height="4"/><rect x="8" y="30" width="48" height="4"/><rect x="12" y="34" width="4" height="4"/><rect x="40" y="34" width="4" height="4"/><rect x="16" y="38" width="4" height="4"/><rect x="36" y="38" width="4" height="4"/><rect x="20" y="42" width="16" height="4"/></g>
  <rect x="44" y="10" width="8" height="8" fill="#C8FF2E"/>
</svg>
`;
}

export function generatedImage(name) {
  return name === 'icon.svg' ? iconSvg() : null;
}
