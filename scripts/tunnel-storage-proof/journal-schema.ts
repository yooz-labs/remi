// #1443 standalone journal accounting; identifiers carry no transfer authority.
export type MarkerKind = 'intent' | 'owned' | 'cleaned';
export type MarkerWitness = {
  kind: MarkerKind;
  dev: string;
  ino: string;
  sha256: string;
  allocated: number;
};
export type JournalBinding = {
  nonce: string;
  home: string;
  scratch: string;
  metadata: string;
  ownership?: MarkerWitness[];
  retirement?: MarkerWitness[];
};
export type JournalLease = Pick<JournalBinding, 'nonce' | 'home' | 'scratch' | 'metadata'> & {
  id: string;
};
const TOKEN = /^[a-f0-9]{32}$/;
const NUMBER = /^(0|[1-9][0-9]{0,19})$/;
const ROOT = /^(0|[1-9][0-9]{0,19}):(0|[1-9][0-9]{0,19})$/;
export const MARKER_ALLOWANCE = 3 * 4096;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function validWitnesses(
  value: unknown,
  kinds: readonly MarkerKind[],
): value is MarkerWitness[] {
  return (
    Array.isArray(value) &&
    value.length === kinds.length &&
    value.every(
      (item, index) =>
        object(item) &&
        Object.keys(item).sort().join() === 'allocated,dev,ino,kind,sha256' &&
        item['kind'] === kinds[index] &&
        typeof item['dev'] === 'string' &&
        NUMBER.test(item['dev']) &&
        typeof item['ino'] === 'string' &&
        NUMBER.test(item['ino']) &&
        typeof item['sha256'] === 'string' &&
        /^[a-f0-9]{64}$/.test(item['sha256']) &&
        typeof item['allocated'] === 'number' &&
        Number.isSafeInteger(item['allocated']) &&
        item['allocated'] >= 0,
    )
  );
}
export function validBinding(value: unknown, state: string): value is JournalBinding {
  if (!object(value)) return false;
  const keys = Object.keys(value).sort().join();
  const base = 'home,metadata,nonce,scratch';
  if (
    ![
      base,
      'home,metadata,nonce,ownership,scratch',
      'home,metadata,nonce,ownership,retirement,scratch',
    ].includes(keys)
  )
    return false;
  if (
    typeof value['nonce'] !== 'string' ||
    !TOKEN.test(value['nonce']) ||
    ![value['home'], value['scratch'], value['metadata']].every(
      (part) => typeof part === 'string' && ROOT.test(part),
    ) ||
    value['scratch'] === value['metadata']
  )
    return false;
  if (state === 'settled') return keys === base;
  if ('ownership' in value && !validWitnesses(value['ownership'], ['intent', 'owned']))
    return false;
  if (
    'retirement' in value &&
    (state !== 'cleanup' ||
      !('ownership' in value) ||
      !validWitnesses(value['retirement'], ['intent', 'owned', 'cleaned']))
  )
    return false;
  return true;
}
export function sameLease(binding: JournalBinding, lease: JournalLease): boolean {
  // Nonce guard: an ID is not the identity of a reservation incarnation.
  return (
    binding.nonce === lease.nonce &&
    binding.home === lease.home &&
    binding.scratch === lease.scratch &&
    binding.metadata === lease.metadata
  );
}
export function sameWitnesses(a: readonly MarkerWitness[], b: readonly MarkerWitness[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => {
      const other = b[index];
      return (
        other &&
        item.kind === other.kind &&
        item.dev === other.dev &&
        item.ino === other.ino &&
        item.sha256 === other.sha256
      );
    })
  );
}
