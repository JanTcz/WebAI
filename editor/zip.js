// Minimal dependency-free ZIP: writing (deflate via CompressionStream, otherwise
// stored) and reading methods 0 and 8. No ZIP64; the editor has a 50 MB limit.

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const toBytes = async (data) =>
  typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());

const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/**
 * @param {[string, string | Blob | Uint8Array][]} entries path → content
 * @returns {Promise<Blob>}
 */
export async function createZip(entries) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [path, data] of entries) {
    const raw = await toBytes(data);
    const name = new TextEncoder().encode(path);
    const deflated = typeof CompressionStream === 'function' ? await pipe(raw, new CompressionStream('deflate-raw')) : null;
    const [method, body] = deflated && deflated.length < raw.length ? [8, deflated] : [0, raw];
    const fields = { method, time, date, crc: crc32(raw), csize: body.length, usize: raw.length, name };
    parts.push(header(0x04034b50, fields), name, body);
    central.push(header(0x02014b50, { ...fields, offset }), name);
    offset += 30 + name.length + body.length;
  }
  const size = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

/** Local (30 B) or central (46 B) header; names in UTF-8 (flag 0x0800). */
function header(sig, { method, time, date, crc, csize, usize, name, offset }) {
  const local = sig === 0x04034b50;
  const v = new DataView(new ArrayBuffer(local ? 30 : 46));
  v.setUint32(0, sig, true);
  let i = 4;
  if (!local) (v.setUint16(i, 20, true), (i += 2)); // version made by
  for (const [n, bytes] of [[20, 2], [0x0800, 2], [method, 2], [time, 2], [date, 2], [crc, 4], [csize, 4], [usize, 4], [name.length, 2]]) {
    bytes === 2 ? v.setUint16(i, n, true) : v.setUint32(i, n, true);
    i += bytes;
  }
  if (!local) v.setUint32(42, offset, true);
  return new Uint8Array(v.buffer);
}

/**
 * @param {Blob | Uint8Array} zip
 * @returns {Promise<{ path: string, data: Uint8Array }[]>} files only, folders are skipped
 */
export async function readZip(zip) {
  const buf = await toBytes(zip);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = buf.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('The file is not a ZIP.');
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupted ZIP.');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const skip = nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const path = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + skip;
    if (path.endsWith('/')) continue;
    if (flags & 1) throw new Error(`Encrypted file in ZIP: ${path}`);
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const body = buf.subarray(start, start + csize);
    if (method === 0) out.push({ path, data: body });
    else if (method === 8) out.push({ path, data: await pipe(body, new DecompressionStream('deflate-raw')) });
    else throw new Error(`Unsupported compression in ZIP (${method}): ${path}`);
  }
  return out;
}
