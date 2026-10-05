import { expect, test } from 'bun:test';
import { relayV2 } from '@remi/shared';
import jsQR from 'jsqr';
import { escapeDeviceName, renderPairingQr } from '../../packages/daemon/src/cli/cmd-relay.ts';

for (const length of [12, 450])
  test(`terminal QR decodes actual ${length}-character relay path and retains four white modules`, async () => {
    const identity = await relayV2.generateIdentity();
    const token = relayV2.encodePairingToken({
      relayUrl: `wss://relay.example/${'x'.repeat(length)}`,
      machinePublicKey: identity.signer.publicKey,
      secret: relayV2.systemRandom(32),
      expiresAtSec: Math.floor(Date.now() / 1000) + 600,
    });
    const rendered = await renderPairingQr(token);
    const lines = rendered.split('\n').map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
    const width = lines[0]?.length ?? 0;
    expect(width).toBeGreaterThan(20);
    for (const line of lines) {
      expect(line.length).toBe(width);
      expect(line.slice(0, 4)).toBe('    ');
      expect(line.slice(-4)).toBe('    ');
    }
    expect(lines.slice(0, 2).every((line) => line.trim() === '')).toBe(true);
    expect(lines.slice(-2).every((line) => line.trim() === '')).toBe(true);
    const scale = 4;
    const height = lines.length * 2;
    const pixels = new Uint8ClampedArray(width * scale * height * scale * 4).fill(255);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const glyph = lines[Math.floor(y / 2)]?.[x];
        const black = glyph === '█' || (y % 2 === 0 ? glyph === '▀' : glyph === '▄');
        if (black)
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) {
              const at = ((y * scale + dy) * width * scale + x * scale + dx) * 4;
              pixels[at] = 0;
              pixels[at + 1] = 0;
              pixels[at + 2] = 0;
            }
      }
    // No token or bitmap artifact leaves this owned in-memory decoder check.
    expect(jsQR(pixels, width * scale, height * scale)?.data === token).toBe(true);
  });
test('local compare device names escape terminal control and bidi characters', () => {
  const escaped = escapeDeviceName('test\x1b[2J\x9b\u202e\nname');
  expect(escaped).not.toContain('\x1b');
  expect(escaped).not.toContain('\x9b');
  expect(escaped).not.toContain('\u202e');
  expect(escaped).not.toContain('\n');
});
