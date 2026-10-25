// Vercel Function entry: every request that isn't a static file in public/ is rewritten here (vercel.json).
import { handler } from '../server/server.js';

export const config = { maxDuration: 20 };
export default function (req, res) {
  return handler(req, res);
}
