import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DetachScanner } from '../../src/cli/detach-scanner';

const CTRL_B = 0x02;

describe('DetachScanner', () => {
  let detached: boolean;
  let forwarded: Buffer[];
  let scanner: DetachScanner;

  beforeEach(() => {
    detached = false;
    forwarded = [];
    scanner = new DetachScanner({
      onDetach: () => {
        detached = true;
      },
      onData: (buf) => {
        forwarded.push(Buffer.from(buf));
      },
      timeoutMs: 1000,
    });
  });

  afterEach(() => {
    scanner.destroy();
  });

  function getForwarded(): Buffer {
    return Buffer.concat(forwarded);
  }

  test('normal data passes through', () => {
    const data = Buffer.from('hello world');
    scanner.write(data);
    expect(getForwarded().toString()).toBe('hello world');
    expect(detached).toBe(false);
  });

  test('Ctrl+B followed by d triggers detach', () => {
    scanner.write(Buffer.from([CTRL_B, 0x64]));
    expect(detached).toBe(true);
    expect(forwarded.length).toBe(0);
  });

  test('Ctrl+B followed by other key forwards both bytes', () => {
    scanner.write(Buffer.from([CTRL_B, 0x61])); // Ctrl+B then 'a'
    expect(detached).toBe(false);
    const result = getForwarded();
    expect(result.length).toBe(2);
    expect(result[0]).toBe(CTRL_B);
    expect(result[1]).toBe(0x61);
  });

  test('Ctrl+B at end of chunk waits for next chunk', () => {
    scanner.write(Buffer.from([CTRL_B]));
    expect(detached).toBe(false);
    expect(forwarded.length).toBe(0);

    // Now send 'd' in next chunk
    scanner.write(Buffer.from([0x64]));
    expect(detached).toBe(true);
  });

  test('Ctrl+B at end of chunk followed by non-d in next chunk', () => {
    scanner.write(Buffer.from([CTRL_B]));
    expect(forwarded.length).toBe(0);

    scanner.write(Buffer.from([0x65])); // 'e'
    expect(detached).toBe(false);
    const result = getForwarded();
    expect(result.length).toBe(2);
    expect(result[0]).toBe(CTRL_B);
    expect(result[1]).toBe(0x65);
  });

  test('Ctrl+B timeout forwards the byte after delay', async () => {
    const shortScanner = new DetachScanner({
      onDetach: () => {
        detached = true;
      },
      onData: (buf) => {
        forwarded.push(Buffer.from(buf));
      },
      timeoutMs: 50,
    });

    shortScanner.write(Buffer.from([CTRL_B]));
    expect(forwarded.length).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(detached).toBe(false);
    const result = getForwarded();
    expect(result.length).toBe(1);
    expect(result[0]).toBe(CTRL_B);
    shortScanner.destroy();
  });

  test('multiple Ctrl+B d sequences in same chunk: first triggers detach', () => {
    // After the first Ctrl+B d, scanner returns (stops processing)
    scanner.write(Buffer.from([CTRL_B, 0x64, CTRL_B, 0x64]));
    expect(detached).toBe(true);
    // No data forwarded (detach happened immediately)
    expect(forwarded.length).toBe(0);
  });

  test('Ctrl+B in middle of data chunk', () => {
    // "ab" + Ctrl+B + "d"
    scanner.write(Buffer.from([0x61, 0x62, CTRL_B, 0x64]));
    expect(detached).toBe(true);
    const result = getForwarded();
    expect(result.toString()).toBe('ab');
  });

  test('data after Ctrl+B non-detach continues normally', () => {
    // Ctrl+B + 'x' + "hello"
    scanner.write(Buffer.from([CTRL_B, 0x78, 0x68, 0x65, 0x6c, 0x6c, 0x6f]));
    expect(detached).toBe(false);
    const result = getForwarded();
    // Should be: Ctrl+B, 'x', 'h', 'e', 'l', 'l', 'o'
    expect(result[0]).toBe(CTRL_B);
    expect(result.subarray(1).toString()).toBe('xhello');
  });

  test('destroy cleans up pending timer', () => {
    scanner.write(Buffer.from([CTRL_B]));
    scanner.destroy();
    // After destroy, no timeout should fire
    expect(forwarded.length).toBe(0);
  });
});
