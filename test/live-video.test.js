import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnnexB, annexbToAvcc, avccDescription, codecString, parameterSets, equalBytes, webCodecsVideo } from '../web/live-video.js';

// A tiny synthetic access unit: SPS, PPS and a one-slice IDR, each with a 4-byte start code.
const sps = new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40, 0x78]);
const pps = new Uint8Array([0x68, 0xee, 0x3c, 0x80]);
const idr = new Uint8Array([0x65, 0x88, 0x84, 0x21, 0xa0]);
const start = [0, 0, 0, 1];
const keyAU = new Uint8Array([...start, ...sps, ...start, ...pps, ...start, ...idr]);

test('Annex B parsing locates every NAL unit with its type and byte range', () => {
  const nals = parseAnnexB(keyAU);
  assert.deepEqual(nals.map(n => n.type), [7, 8, 5]);
  assert.deepEqual(keyAU.subarray(nals[0].start, nals[0].end), sps);
  assert.deepEqual(keyAU.subarray(nals[1].start, nals[1].end), pps);
  assert.deepEqual(keyAU.subarray(nals[2].start, nals[2].end), idr);
  // A 3-byte start code is accepted too; encoders may mix lengths between NALs.
  const mixed = new Uint8Array([0, 0, 1, 0x41, 0x9a, ...start, 0x41, 0x10]);
  assert.deepEqual(parseAnnexB(mixed).map(n => n.type), [1, 1]);
});

test('malformed access units fail closed', () => {
  for (const bad of [
    new Uint8Array(0), new Uint8Array([0, 0, 0, 1]),
    new Uint8Array([1, 2, 3, 4, 5]),
    new Uint8Array([...start, 0xe5, 0x88]),          // forbidden_zero_bit
    new Uint8Array([...start, 0x00, 0x88]),          // NAL type 0
    new Uint8Array([...start, 0x7f, 0x88]),          // NAL type 31
    new Uint8Array([...start, ...idr, ...start, ...start, ...idr]), // zero-length NAL
  ]) assert.throws(() => parseAnnexB(bad), /invalid_annexb/);
});

test('AVCC repackaging length-prefixes each NAL for VideoDecoder chunks', () => {
  const avcc = annexbToAvcc(keyAU);
  const view = new DataView(avcc.buffer);
  assert.equal(view.getUint32(0), sps.length);
  assert.deepEqual(avcc.subarray(4, 4 + sps.length), sps);
  const ppsAt = 4 + sps.length;
  assert.equal(view.getUint32(ppsAt), pps.length);
  const idrAt = ppsAt + 4 + pps.length;
  assert.equal(view.getUint32(idrAt), idr.length);
  assert.equal(avcc.length, idrAt + 4 + idr.length);
});

test('the avcC description and codec string come from the in-band parameter sets', () => {
  const nals = parseAnnexB(keyAU);
  const { sps: foundSps, pps: foundPps } = parameterSets(keyAU, nals);
  assert.deepEqual(foundSps, sps);
  assert.deepEqual(foundPps, pps);
  const description = avccDescription(foundSps, foundPps);
  assert.deepEqual([...description.subarray(0, 8)], [1, 0x64, 0x00, 0x28, 0xff, 0xe1, 0, sps.length]);
  assert.deepEqual(description.subarray(8, 8 + sps.length), sps);
  assert.equal(description[8 + sps.length], 1);
  assert.deepEqual(description.subarray(-pps.length), pps);
  assert.equal(codecString(foundSps), 'avc1.640028');
  assert.throws(() => parameterSets(keyAU, nals.filter(n => n.type === 5)), /missing_parameters/);
  assert.throws(() => avccDescription(new Uint8Array([0x67]), pps), /invalid_parameters/);
  assert.equal(equalBytes(description, new Uint8Array(description)), true);
  assert.equal(equalBytes(description, description.subarray(0, -1)), false);
});

test('compatibility mode engages exactly when WebCodecs is absent', () => {
  assert.equal(webCodecsVideo({}), false, 'No WebCodecs: the viewer must stay on JPEG snapshots');
  assert.equal(webCodecsVideo({ VideoDecoder: function () {}, EncodedVideoChunk: function () {} }), false);
  const scope = { VideoDecoder: function () {}, EncodedVideoChunk: function () {}, VideoFrame: function () {} };
  assert.equal(webCodecsVideo(scope), true);
});
