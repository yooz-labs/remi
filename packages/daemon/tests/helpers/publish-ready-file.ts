import * as fs from 'node:fs';

export function publishReadyFile(path: string, value: unknown): void {
  fs.writeFileSync(`${path}.next`, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(`${path}.next`, path);
}
