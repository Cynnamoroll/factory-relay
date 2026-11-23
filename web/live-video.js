// H.264 Annex B parsing and AVCC repackaging for the WebCodecs live view.
// These are pure functions shared by the browser (web/app.js) and the relay-side
// validator (src/stream.js), so the node test suite exercises the exact browser logic.
//
// Annex B framing chosen for the wire: every NAL unit is prefixed with the 4-byte
// start code 00 00 00 01. Each access unit is one packet. Keyframe access units are
// prefixed with in-band SPS and PPS NALs, so a decoder can join at any keyframe.

/** Locates NAL unit boundaries. Throws on malformed input so callers fail closed. */
export function parseAnnexB(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5) throw new Error('invalid_annexb');
  const startCodeAt = index =>
    (index + 4 <= bytes.length && bytes[index] === 0 && bytes[index + 1] === 0 &&
      bytes[index + 2] === 0 && bytes[index + 3] === 1) ? 4
      : (index + 3 <= bytes.length && bytes[index] === 0 && bytes[index + 1] === 0 &&
        bytes[index + 2] === 1) ? 3 : 0;
  const first = startCodeAt(0);
  if (!first) throw new Error('invalid_annexb');
  const nals = [];
  let nalStart = first;
  let scan = first;
  while (true) {
    let next = -1, nextPrefix = 0;
    for (let j = scan; j + 3 <= bytes.length; j++) {
      const prefix = startCodeAt(j);
      if (prefix) { next = j; nextPrefix = prefix; break; }
    }
    const nalEnd = next === -1 ? bytes.length : next;
    // H.264 encoders insert emulation-prevention bytes, so payload never contains a start code.
    if (nalEnd === nalStart) throw new Error('invalid_annexb');
    const header = bytes[nalStart];
    if (header & 0x80) throw new Error('invalid_annexb');
    const type = header & 0x1f;
    if (type < 1 || type > 23) throw new Error('invalid_annexb');
    nals.push({ type, start: nalStart, end: nalEnd });
    if (next === -1) return nals;
    nalStart = next + nextPrefix;
    scan = next + nextPrefix;
  }
}

/** Repackages an Annex B access unit as AVCC (4-byte big-endian length-prefixed NALs). */
export function annexbToAvcc(bytes, nals = parseAnnexB(bytes)) {
  let total = 0;
  for (const nal of nals) total += 4 + (nal.end - nal.start);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const nal of nals) {
    view.setUint32(offset, nal.end - nal.start);
    out.set(bytes.subarray(nal.start, nal.end), offset + 4);
    offset += 4 + (nal.end - nal.start);
  }
  return out;
}

/** Builds the avcC decoder configuration record from raw SPS and PPS NAL bytes. */
export function avccDescription(sps, pps) {
  if (!(sps instanceof Uint8Array) || sps.length < 4 || sps.length > 1024 ||
      !(pps instanceof Uint8Array) || pps.length < 1 || pps.length > 1024) throw new Error('invalid_parameters');
  const out = new Uint8Array(11 + sps.length + pps.length);
  out[0] = 1;        // configurationVersion
  out[1] = sps[1];   // AVCProfileIndication
  out[2] = sps[2];   // profile_compatibility
  out[3] = sps[3];   // AVCLevelIndication
  out[4] = 0xff;     // reserved bits + 4-byte NAL length size
  out[5] = 0xe1;     // reserved bits + one SPS
  out[6] = sps.length >> 8;
  out[7] = sps.length & 0xff;
  out.set(sps, 8);
  const base = 8 + sps.length;
  out[base] = 1;     // one PPS
  out[base + 1] = pps.length >> 8;
  out[base + 2] = pps.length & 0xff;
  out.set(pps, base + 3);
  return out;
}

/** The avc1.PPCCLL codec string VideoDecoder expects, from raw SPS NAL bytes. */
export function codecString(sps) {
  if (!(sps instanceof Uint8Array) || sps.length < 4) throw new Error('invalid_sps');
  return 'avc1.' + [...sps.subarray(1, 4)].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Byte-wise comparison for decoder configuration records. */
export const equalBytes = (a, b) => a instanceof Uint8Array && b instanceof Uint8Array &&
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/** Extracts the SPS and PPS NAL byte ranges from a parsed keyframe access unit. */
export function parameterSets(bytes, nals) {
  const sps = nals.find(nal => nal.type === 7), pps = nals.find(nal => nal.type === 8);
  if (!sps || !pps) throw new Error('missing_parameters');
  return { sps: bytes.subarray(sps.start, sps.end), pps: bytes.subarray(pps.start, pps.end) };
}

/** True when this environment can decode H.264 through WebCodecs. */
export function webCodecsVideo(scope = globalThis) {
  return typeof scope.VideoDecoder === 'function' && typeof scope.EncodedVideoChunk === 'function' &&
    typeof scope.VideoFrame === 'function';
}
