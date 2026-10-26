// 개발용 정적 서버(의존성 없음). 같은 Wi-Fi의 휴대폰에서도 접속할 수 있도록 0.0.0.0에 연다.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT) || 5180;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(join(root, path));
  // 프로젝트 밖 경로와 .git, .claude 같은 숨김 폴더는 내보내지 않는다.
  const relative = file.slice(root.length);
  if (!file.startsWith(root + sep) || relative.split(sep).some((p) => p.startsWith('.'))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`PC:    http://localhost:${port}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets ?? []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`휴대폰: http://${n.address}:${port} (같은 Wi-Fi)`);
    }
  }
});
