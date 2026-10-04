import type { relayV2 as r } from '../../src/index.ts';

export interface Recorder {
  readonly io: r.ChannelIO;
  readonly frames: Uint8Array[];
  readonly closes: { code: number; reason: string }[];
}

export function recorder(): Recorder {
  const frames: Uint8Array[] = [];
  const closes: { code: number; reason: string }[] = [];
  return {
    frames,
    closes,
    io: {
      emit: (f) => {
        frames.push(f);
      },
      close: (code, reason) => {
        closes.push({ code, reason });
      },
    },
  };
}
