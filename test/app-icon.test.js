import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appIconSvg, appIconIcns, iconset, renderIcon } from '../scripts/app-icon.js';

test('the committed vector icon source matches the generator geometry', () => {
  assert.equal(readFileSync(new URL('../host/AppIcon.svg', import.meta.url), 'utf8'), appIconSvg(),
    'Regenerate host/AppIcon.svg from scripts/app-icon.js after changing the icon geometry');
});

test('the bundled icns carries every iconset size as a valid PNG and is reproducible', () => {
  const icns = appIconIcns();
  assert.equal(icns.toString('ascii', 0, 4), 'icns');
  assert.equal(icns.readUInt32BE(4), icns.length);
  const seen = [];
  for (let offset = 8; offset < icns.length;) {
    const type = icns.toString('ascii', offset, offset + 4), length = icns.readUInt32BE(offset + 4);
    const data = icns.subarray(offset + 8, offset + length);
    assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${type} must contain a PNG`);
    seen.push([type, data.readUInt32BE(16), data.readUInt32BE(20)]);
    offset += length;
  }
  assert.deepEqual(seen, iconset.map(([, size, type]) => [type, size, size]));
  assert.ok(appIconIcns().equals(icns), 'Rendering is deterministic');
  const small = renderIcon(64);
  assert.equal(small[3], 0, 'Corners stay transparent outside the rounded body');
  assert.equal(small[(32 * 64 + 32) * 4 + 3], 255, 'The body is opaque');
});
