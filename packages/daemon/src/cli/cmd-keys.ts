/**
 * Dispatcher for the five key-management subcommands:
 *   `remi keygen`
 *   `remi export-key`
 *   `remi import-key <file>`
 *   `remi authorize <key-or-fingerprint>`
 *   `remi keys`
 *
 * Each target has its own standalone module (`./keygen.ts`, `./key-export.ts`,
 * `./key-import.ts`, `./authorize.ts`); this dispatcher decides which to load
 * based on the subcommand string and shapes the flags into the options the
 * target expects.
 */

export type KeysSubcommand = 'keygen' | 'export-key' | 'import-key' | 'authorize' | 'keys';

export function isKeysSubcommand(value: unknown): value is KeysSubcommand {
  return (
    value === 'keygen' ||
    value === 'export-key' ||
    value === 'import-key' ||
    value === 'authorize' ||
    value === 'keys'
  );
}

export interface KeysCommandFlags {
  readonly subcommandArg?: string;
  readonly usePassphrase?: boolean;
  readonly decrypt?: boolean;
  readonly encrypt?: boolean;
  readonly force?: boolean;
  readonly publicOnly?: boolean;
  readonly label?: string;
  readonly removeFingerprint?: string;
}

export async function runKeysCommand(
  sub: KeysSubcommand,
  flags: KeysCommandFlags,
): Promise<number> {
  if (sub === 'keygen') {
    const { runKeygen } = await import('./keygen.ts');
    const passphrase = process.env['REMI_PASSPHRASE'];
    await runKeygen({
      ...(passphrase !== undefined && { passphrase }),
      ...(flags.usePassphrase !== undefined && { usePassphrase: flags.usePassphrase }),
      ...(flags.decrypt !== undefined && { decrypt: flags.decrypt }),
      ...(flags.encrypt !== undefined && { encrypt: flags.encrypt }),
      ...(flags.force !== undefined && { force: flags.force }),
    });
    return 0;
  }
  if (sub === 'export-key') {
    const { runKeyExport } = await import('./key-export.ts');
    runKeyExport({ ...(flags.publicOnly !== undefined && { publicOnly: flags.publicOnly }) });
    return 0;
  }
  if (sub === 'import-key') {
    const { runKeyImport } = await import('./key-import.ts');
    await runKeyImport({
      ...(flags.subcommandArg !== undefined && { file: flags.subcommandArg }),
      ...(flags.force !== undefined && { force: flags.force }),
    });
    return 0;
  }
  if (sub === 'authorize') {
    const { runAuthorize } = await import('./authorize.ts');
    await runAuthorize({
      ...(flags.subcommandArg !== undefined && { input: flags.subcommandArg }),
      ...(flags.label !== undefined && { label: flags.label }),
      ...(flags.removeFingerprint !== undefined && { remove: flags.removeFingerprint }),
    });
    return 0;
  }
  // 'keys'
  const { runListKeys } = await import('./authorize.ts');
  runListKeys();
  return 0;
}
