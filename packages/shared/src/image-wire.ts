/** Internal scalar/frame guards shared by the accepted image operations; grants no authority. */
import { fromB64u, fromUtf8, utf8 } from './relay/bytes.ts';
import { parseStrictJson } from './relay/strict-json.ts';

export const IMAGE_WIRE_LIMITS = { frameBytes: 65536, bindingBytes: 200 } as const;

export type Guard = (value: unknown) => boolean;
export const scalar = (value: string): boolean => fromUtf8(utf8(value)) === value;
export const uuid: Guard = (v) =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const uuid4: Guard = (v) =>
  uuid(v) &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v as string);
export const date: Guard = (v) =>
  typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  new Date(v).toISOString() === v;
export const integer =
  (min: number, max: number): Guard =>
  (v) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
export const encoded =
  (min: number, max: number): Guard =>
  (value) => {
    if (typeof value !== 'string' || value.length > Math.ceil((max * 4) / 3)) return false;
    const bytes = fromB64u(value);
    return bytes.length >= min && bytes.length <= max;
  };
export const exact = (
  value: unknown,
  fields: Record<string, Guard>,
): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== Object.keys(fields).length) return false;
  return Object.entries(fields).every(
    ([key, guard]) => Object.prototype.hasOwnProperty.call(object, key) && guard(object[key]),
  );
};
export const binding: Guard = (v) =>
  exact(v, {
    harness: (h) => h === 'claude',
    harnessSessionId: (s) =>
      typeof s === 'string' &&
      s.length > 0 &&
      scalar(s) &&
      utf8(s).length <= IMAGE_WIRE_LIMITS.bindingBytes &&
      !/[\u0000-\u001f\u007f-\u009f]/.test(s),
  });
export function imageWireValue(input: string | Uint8Array): unknown {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) return null;
  if (input.length > IMAGE_WIRE_LIMITS.frameBytes) return null;
  const text = typeof input === 'string' ? input : fromUtf8(input);
  if (!scalar(text) || utf8(text).length > IMAGE_WIRE_LIMITS.frameBytes) return null;
  return parseStrictJson(text, IMAGE_WIRE_LIMITS.frameBytes);
}
// The strict parser bounds depth/nodes; also reject escaped lone surrogates in invalid fields/keys.
export function scalarJson(value: unknown): boolean {
  if (typeof value === 'string') return scalar(value);
  if (Array.isArray(value)) return value.every(scalarJson);
  if (value && typeof value === 'object')
    return Object.entries(value).every(([key, item]) => scalar(key) && scalarJson(item));
  return true;
}
