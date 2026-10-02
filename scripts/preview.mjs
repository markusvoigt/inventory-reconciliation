import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root = new URL('../', import.meta.url).pathname;
const files = {'/': ['preview/index.html', 'text/html'], '/preview.js': ['dist/preview.js', 'text/javascript'], '/preview.js.map': ['dist/preview.js.map', 'application/json']};
createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = files[pathname];
  if (!file) { res.writeHead(404); res.end(); return; }
  try { const data = await readFile(resolve(root, file[0])); res.writeHead(200, {'Content-Type': file[1], 'Cache-Control': 'no-store'}); res.end(data); }
  catch { res.writeHead(500); res.end('Run npm run build first.'); }
}).listen(4317, '127.0.0.1', () => console.log('Native Polaris preview: http://127.0.0.1:4317 (synthetic data only)'));
