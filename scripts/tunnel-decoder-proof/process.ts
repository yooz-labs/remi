// #1170 private candidate. Process lifetime controls are not a portable memory ceiling.
import { admitImage } from './admission';

export const MAX_RESULT_BYTES = 4096;
export interface DecodedPixels {
  width: number;
  height: number;
  pixelBytes: number;
  pixelSha256: string;
}
export class DecoderProcessError extends Error {
  constructor(readonly code: 'busy' | 'cancelled' | 'expired' | 'protocol' | 'failed' | 'refused') {
    super(`DECODER_PROCESS_${code.toUpperCase()}`);
  }
}

export class DecoderProcess {
  private busy = false;
  lastChildPID: number | undefined;

  constructor(private readonly command: readonly string[]) {}

  async decode(
    bytes: Buffer,
    mediaType: 'image/png' | 'image/jpeg',
    options: { signal?: AbortSignal; milliseconds?: number } = {},
  ): Promise<DecodedPixels> {
    if (this.busy) throw new DecoderProcessError('busy');
    if (options.signal?.aborted) throw new DecoderProcessError('cancelled');
    const milliseconds = options.milliseconds ?? 5000;
    if (!Number.isFinite(milliseconds) || milliseconds < 1 || milliseconds > 5000)
      throw new DecoderProcessError('expired');
    let admitted: ReturnType<typeof admitImage>;
    try {
      admitted = admitImage(bytes, mediaType);
    } catch {
      throw new DecoderProcessError('refused');
    }
    const ownedBytes = Buffer.from(bytes);
    this.busy = true;
    let child: Bun.Subprocess<'pipe', 'pipe', 'ignore'> | undefined;
    let failure: DecoderProcessError | undefined;
    let interrupt!: (error: DecoderProcessError) => void;
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = reject;
    });
    const end = performance.now() + milliseconds;
    const fail = (code: DecoderProcessError['code']) => {
      failure ??= new DecoderProcessError(code);
      child?.kill('SIGKILL');
      interrupt(failure);
    };
    const abort = () => fail('cancelled');
    const timer = setTimeout(() => fail('expired'), milliseconds);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal?.aborted) throw new DecoderProcessError('cancelled');
      const started = Bun.spawn([...this.command, mediaType], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
        // No application credentials or configuration are inherited by the worker.
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          LANG: 'en_US.UTF-8',
          TMPDIR: process.env['TMPDIR'] ?? '/tmp',
        },
      });
      child = started;
      this.lastChildPID = child.pid;
      const output = (async () => {
        const parts: Uint8Array[] = [];
        let size = 0;
        for await (const part of started.stdout) {
          size += part.byteLength;
          if (size > MAX_RESULT_BYTES) {
            fail('protocol');
            throw failure;
          }
          parts.push(part);
        }
        return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
      })();
      const input = (async () => {
        started.stdin.write(ownedBytes);
        await started.stdin.end();
      })();
      const [raw, exit] = await Promise.race([
        Promise.all([output, started.exited, input]),
        interrupted,
      ]);
      if (failure) throw failure;
      if (options.signal?.aborted) throw new DecoderProcessError('cancelled');
      if (performance.now() >= end) throw new DecoderProcessError('expired');
      if (exit !== 0) {
        throw new DecoderProcessError(raw === '{"kind":"refused"}\n' ? 'refused' : 'failed');
      }
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(raw);
      } catch {
        throw new DecoderProcessError('protocol');
      }
      if (
        !result ||
        Array.isArray(result) ||
        Object.keys(result).sort().join(',') !== 'height,kind,pixelBytes,pixelSha256,width' ||
        result['kind'] !== 'decoded' ||
        result['width'] !== admitted.width ||
        result['height'] !== admitted.height ||
        result['pixelBytes'] !== admitted.width * admitted.height * 4 ||
        typeof result['pixelSha256'] !== 'string' ||
        !/^[0-9a-f]{64}$/.test(result['pixelSha256'])
      )
        throw new DecoderProcessError('protocol');
      return {
        width: admitted.width,
        height: admitted.height,
        pixelBytes: result['pixelBytes'] as number,
        pixelSha256: result['pixelSha256'],
      };
    } catch (error) {
      if (error instanceof DecoderProcessError) throw error;
      throw failure ?? new DecoderProcessError('failed');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (child) {
        // A slot stays occupied until the owned OS process has actually exited.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await child.exited;
      }
      this.busy = false;
    }
  }
}
