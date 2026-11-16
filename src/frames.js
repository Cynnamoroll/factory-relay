import { mkdir, lstat, readdir, open, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function validPng(bytes) {
  let dataSeen = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length || (offset === 8 && size !== 13)) return false;
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(offset + 4, end - 4)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT' && size > 0) dataSeen = true;
    if (type === 'IEND') return size === 0 && end === bytes.length && dataSeen;
    offset = end;
  }
  return false;
}

export async function saveFrame(config, observationId, result) {
  let destination;
  let created = false;
  try {
    if (result.observationId !== observationId || result.mediaType !== 'image/png' ||
        typeof result.base64 !== 'string' || result.base64.length > 699052 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)) throw new Error();
    const bytes = Buffer.from(result.base64, 'base64');
    if (bytes.length < 33 || bytes.length > 512 * 1024 || bytes.length !== result.bytes ||
        bytes.toString('base64') !== result.base64 ||
        !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
        bytes.toString('ascii', 12, 16) !== 'IHDR' ||
        bytes.readUInt32BE(16) !== result.width || bytes.readUInt32BE(20) !== result.height ||
        !Number.isInteger(result.width) || !Number.isInteger(result.height) ||
        result.width < 1 || result.height < 1 || result.width > 8192 || result.height > 8192 ||
        result.width * result.height > 32000000 ||
        createHash('sha256').update(bytes).digest('hex') !== result.sha256 || !validPng(bytes)) throw new Error();
    const workspace = config.localWorkspace ?? fileURLToPath(new URL('../', import.meta.url));
    const root = path.join(workspace, '.applets-artifacts');
    try { await mkdir(root, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error();
    if ((await readdir(root)).length >= 100) throw new Error();
    destination = path.join(root, observationId + '-' + randomBytes(8).toString('hex') + '.png');
    const handle = await open(destination, 'wx', 0o600);
    created = true;
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    return { observationId, mediaType: 'image/png', sha256: result.sha256,
      width: result.width, height: result.height, bytes: result.bytes, localPath: destination };
  } catch {
    if (created) await unlink(destination).catch(() => {});
    throw new Error('invalid_frame_response');
  }
}
