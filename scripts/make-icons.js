// 앱 아이콘 PNG 생성(의존성 없음): 어두운 배경 + 룸 3개를 뜻하는 문 3개.
// 실행: npm run icons
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BG = [30, 41, 59];
const DOOR = [245, 158, 11];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 아이콘 안쪽 80%(maskable 안전 영역)에 문 3개를 그린다.
function isDoor(u, v) {
  if (v < 0.3 || v > 0.72) return false;
  for (let i = 0; i < 3; i++) {
    const x0 = 0.2 + i * 0.22;
    if (u >= x0 && u <= x0 + 0.16) {
      // 위쪽 모서리를 둥글게
      const r = 0.05;
      const cy = 0.3 + r;
      if (v < cy) {
        const cx = u < x0 + r ? x0 + r : u > x0 + 0.16 - r ? x0 + 0.16 - r : u;
        return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
      }
      return true;
    }
  }
  return false;
}

function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = isDoor((x + 0.5) / size, (y + 0.5) / size) ? DOOR : BG;
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = fileURLToPath(new URL('../icons/', import.meta.url));
mkdirSync(dir, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(dir + name, png(size));
  console.log(`icons/${name} (${size}px)`);
}
