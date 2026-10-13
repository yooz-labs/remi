// #1170 internal decoder controller. Process lifetime controls are not a portable memory ceiling.
import { admitImage } from './image-admission';

export const MAX_RESULT_BYTES = 4096;
export interface DecodedPixels {
  width: number;
  height: number;
  pixelBytes: number;
  pixelSha256: string;
}
export interface RepeatedDecodeReady extends DecodedPixels {
  decodes: number;
}
/** Owned process metadata only: never decoder input, output content or stderr. */
export interface DecoderChildExit {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly elapsedMs: number;
}
export class DecoderProcessError extends Error {
  constructor(readonly code: 'busy' | 'cancelled' | 'expired' | 'protocol' | 'failed' | 'refused') {
    super(`DECODER_PROCESS_${code.toUpperCase()}`);
  }
}

/** #1417: explicit interpreter policy for disposable decoder children only. */
function decoderWorkerEnvironment() {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    TMPDIR: process.env['TMPDIR'] ?? '/tmp',
    BUN_JSC_useJIT: '0',
  };
}

export class DecoderProcess {
  private busy = false;
  lastChildPID: number | undefined;
  lastChildExit: Readonly<DecoderChildExit> | undefined;

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
    this.lastChildExit = undefined;
    const startedAt = performance.now();
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
        env: decoderWorkerEnvironment(),
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
        this.lastChildExit = Object.freeze({
          pid: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          elapsedMs: performance.now() - startedAt,
        });
      }
      this.busy = false;
    }
  }

  /** Keep one owned child fully decoding until its parent cancels or its deadline expires. */
  async decodeRepeated(
    bytes: Buffer,
    mediaType: 'image/png' | 'image/jpeg',
    options: {
      signal: AbortSignal;
      milliseconds?: number;
      onReady: (result: RepeatedDecodeReady) => void;
    },
  ): Promise<void> {
    if (this.busy) throw new DecoderProcessError('busy');
    if (options.signal.aborted) throw new DecoderProcessError('cancelled');
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
    this.lastChildExit = undefined;
    const startedAt = performance.now();
    let child: Bun.Subprocess<'pipe', 'pipe', 'ignore'> | undefined;
    let failure: DecoderProcessError | undefined;
    let interrupt!: (error: DecoderProcessError) => void;
    let resolveReady!: (result: RepeatedDecodeReady) => void;
    let rejectReady!: (error: DecoderProcessError) => void;
    const interrupted = new Promise<never>((_, reject) => {
      interrupt = reject;
    });
    const ready = new Promise<RepeatedDecodeReady>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const end = performance.now() + milliseconds;
    const fail = (code: DecoderProcessError['code']) => {
      if (failure) return;
      failure = new DecoderProcessError(code);
      child?.kill('SIGKILL');
      rejectReady(failure);
      interrupt(failure);
    };
    const abort = () => fail('cancelled');
    const timer = setTimeout(() => fail('expired'), milliseconds);
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal.aborted) throw new DecoderProcessError('cancelled');
      const started = Bun.spawn([...this.command, '--repeat-decode', mediaType], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'ignore',
        env: decoderWorkerEnvironment(),
      });
      child = started;
      this.lastChildPID = child.pid;
      void started.exited.then(() => fail('failed'));
      const output = (async () => {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let received = 0;
        let buffer = '';
        let readyReceived = false;
        for await (const part of started.stdout) {
          received += part.byteLength;
          if (received > MAX_RESULT_BYTES) {
            fail('protocol');
            return;
          }
          const chunk = decoder.decode(part, { stream: true });
          if (readyReceived && chunk.length > 0) {
            fail('protocol');
            return;
          }
          buffer += chunk;
          const newline = buffer.indexOf('\n');
          if (newline < 0) continue;
          if (readyReceived || newline !== buffer.length - 1) {
            fail('protocol');
            return;
          }
          let result: Record<string, unknown>;
          try {
            result = JSON.parse(buffer.slice(0, newline));
          } catch {
            fail('protocol');
            return;
          }
          if (
            !result ||
            Array.isArray(result) ||
            Object.keys(result).sort().join(',') !==
              'decodes,height,kind,pixelBytes,pixelSha256,width' ||
            result['kind'] !== 'ready' ||
            result['decodes'] !== 2 ||
            result['width'] !== admitted.width ||
            result['height'] !== admitted.height ||
            result['pixelBytes'] !== admitted.width * admitted.height * 4 ||
            typeof result['pixelSha256'] !== 'string' ||
            !/^[0-9a-f]{64}$/.test(result['pixelSha256'])
          ) {
            fail('protocol');
            return;
          }
          readyReceived = true;
          buffer = '';
          resolveReady({
            decodes: 2,
            width: admitted.width,
            height: admitted.height,
            pixelBytes: result['pixelBytes'] as number,
            pixelSha256: result['pixelSha256'],
          });
        }
        if (!readyReceived) fail('protocol');
      })();
      void output.catch(() => fail('protocol'));
      void (async () => {
        started.stdin.write(ownedBytes);
        await started.stdin.end();
      })().catch(() => fail('failed'));
      const result = await Promise.race([ready, interrupted]);
      if (failure) throw failure;
      if (options.signal.aborted) throw new DecoderProcessError('cancelled');
      if (performance.now() >= end) throw new DecoderProcessError('expired');
      options.onReady(result);
      await interrupted;
    } catch (error) {
      if (error instanceof DecoderProcessError) throw error;
      throw failure ?? new DecoderProcessError('failed');
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      if (child) {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await child.exited;
        this.lastChildExit = Object.freeze({
          pid: child.pid,
          exitCode: child.exitCode,
          signalCode: child.signalCode,
          elapsedMs: performance.now() - startedAt,
        });
      }
      this.busy = false;
    }
  }
}
