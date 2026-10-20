/** Independent ADR0042 expectations: this generator imports no production codec or guards. */
import { writeFileSync } from 'node:fs';

const envelope = {
  id: '00112233-4455-4677-8899-aabbccddeeff',
  timestamp: '2026-10-13T12:00:00.000Z',
  sessionId: '00112233-4455-7677-8899-aabbccddeeff',
};
const artifactId = Buffer.alloc(16, 2).toString('base64url');
const request = {
  ...envelope,
  type: 'image_insert_request',
  binding: { harness: 'claude', harnessSessionId: 'session-🌱' },
  artifactId,
};
const refusalCodes = [
  'malformed',
  'unavailable',
  'busy',
  'conflict',
  'expired',
  'binding_changed',
  'prompt_up',
];
const positive: {
  name: string;
  raw: string;
  expected: Record<string, unknown>;
  ingress: unknown;
}[] = [];
const negative: {
  name: string;
  raw?: string;
  bytes?: number[];
  units?: number[];
  ingress: unknown;
}[] = [];
const uncorrelatable = { kind: 'uncorrelatable' };
const correlation = (hint: string | null = artifactId) => ({
  kind: 'malformed',
  correlation: { requestId: envelope.id, sessionId: envelope.sessionId, artifactId: hint },
});
function good(name: string, value: Record<string, unknown>, raw = JSON.stringify(value)) {
  positive.push({
    name,
    raw,
    expected: value,
    ingress:
      value['type'] === 'image_insert_request'
        ? { kind: 'request', request: value }
        : uncorrelatable,
  });
}
function bad(name: string, value: unknown, ingress: unknown = uncorrelatable) {
  negative.push({ name, raw: JSON.stringify(value), ingress });
}
function rawBad(name: string, raw: string, ingress: unknown = uncorrelatable) {
  negative.push({ name, raw, ingress });
}
good('request', request);
good('binding200bytes', {
  ...request,
  binding: { harness: 'claude', harnessSessionId: '🌱'.repeat(50) },
});
const reordered = {
  artifactId,
  binding: request.binding,
  sessionId: request.sessionId,
  timestamp: request.timestamp,
  id: request.id,
  type: request.type,
};
good('reordered', request, JSON.stringify(reordered));
good(
  'escaped-key-type',
  request,
  JSON.stringify(request)
    .replace('"type"', '"t\\u0079pe"')
    .replace('image_insert_request', 'image\\u005finsert\\u005frequest'),
);
const requestRaw = JSON.stringify(request);
good('frame65536bytes', request, requestRaw + ' '.repeat(65536 - Buffer.byteLength(requestRaw)));
for (const [outcome, code] of [
  ['inserted', 'none'],
  ['uncertain', 'delivery_unknown'],
  ...refusalCodes.map((code) => ['refused', code]),
])
  good(`${outcome}:${code}`, {
    ...envelope,
    type: 'image_insert_result',
    requestId: '11112233-4455-4677-8899-aabbccddeeff',
    outcome,
    code,
  });

for (const vector of [...positive].filter(
  (v) => !['reordered', 'escaped-key-type', 'frame65536bytes'].includes(v.name),
)) {
  const value = vector.expected;
  const isRequest = value['type'] === 'image_insert_request';
  bad(
    `${vector.name}:extra`,
    { ...value, extra: true },
    isRequest ? correlation() : uncorrelatable,
  );
  for (const key of Object.keys(value)) {
    const copy = { ...value };
    delete copy[key];
    const body = isRequest && ['binding', 'artifactId'].includes(key);
    const hint = key === 'artifactId' ? null : artifactId;
    bad(`${vector.name}:missing:${key}`, copy, body ? correlation(hint) : uncorrelatable);
    bad(
      `${vector.name}:type:${key}`,
      { ...value, [key]: [] },
      body ? correlation(hint) : uncorrelatable,
    );
  }
}
for (const id of [
  '',
  envelope.id.toUpperCase(),
  envelope.id.replace('-4677-', '-7677-'),
  envelope.id.replace('-8899-', '-0899-'),
  'not-an-id',
])
  bad(`id:${id}`, { ...request, id });
for (const sessionId of ['', envelope.sessionId.toUpperCase(), 'not-a-session'])
  bad(`session:${sessionId}`, { ...request, sessionId });
for (const timestamp of [
  '',
  '2026-02-29T12:00:00.000Z',
  '2026-10-13T24:00:00.000Z',
  '2026-10-13T12:00:00Z',
  '2026-10-13T12:00:00.000+00:00',
  '9999-99-99T00:00:00.000Z',
])
  bad(`timestamp:${timestamp}`, { ...request, timestamp });
for (const [index, value] of [
  '',
  '?',
  'AA',
  `${artifactId}=`,
  `${artifactId.slice(0, -1)}h`,
  Buffer.alloc(15).toString('base64url'),
  Buffer.alloc(17).toString('base64url'),
  '+'.repeat(22),
  '/'.repeat(22),
  0,
  null,
].entries())
  bad(`artifact:${index}`, { ...request, artifactId: value }, correlation(null));
for (const [index, binding] of [
  null,
  [],
  { harness: 'codex', harnessSessionId: 'owned' },
  { harness: 'claude', harnessSessionId: '' },
  { harness: 'claude', harnessSessionId: `${'🌱'.repeat(50)}a` },
  { harness: 'claude', harnessSessionId: 'owned', extra: true },
  { harness: 'claude' },
].entries())
  bad(`binding:${index}`, { ...request, binding }, correlation());
for (const control of [0, 1, 10, 13, 31, 127, 128, 159])
  bad(
    `binding-control:${control}`,
    {
      ...request,
      binding: { harness: 'claude', harnessSessionId: `owned${String.fromCharCode(control)}` },
    },
    correlation(),
  );
for (const [name, value] of [
  ['high', '\ud800'],
  ['low', '\udc00'],
] as const) {
  bad(`binding-surrogate:${name}`, {
    ...request,
    binding: { harness: 'claude', harnessSessionId: value },
  });
  bad(`extra-surrogate:${name}`, { ...request, extra: value });
  bad(`key-surrogate:${name}`, { ...request, [value]: 'owned' });
  bad(`nested-surrogate:${name}`, { ...request, extra: { values: [value] } });
}
for (const outcome of ['inserted', 'refused', 'uncertain', '', 'allowed'])
  for (const code of ['none', 'delivery_unknown', ...refusalCodes, '', 'denied']) {
    const valid =
      (outcome === 'inserted' && code === 'none') ||
      (outcome === 'uncertain' && code === 'delivery_unknown') ||
      (outcome === 'refused' && refusalCodes.includes(code));
    if (!valid)
      bad(`pair:${outcome}:${code}`, {
        ...envelope,
        type: 'image_insert_result',
        requestId: envelope.id,
        outcome,
        code,
      });
  }
for (const key of Object.keys(request)) {
  const value = request[key as keyof typeof request];
  rawBad(
    `duplicate:${key}`,
    `${requestRaw.slice(0, -1)},${JSON.stringify(key)}:${JSON.stringify(value)}}`,
  );
}
rawBad('duplicate-escaped-type', `${requestRaw.slice(0, -1)},"t\\u0079pe":"image_insert_request"}`);
rawBad(
  'duplicate-binding-key',
  requestRaw.replace('"harness":"claude"', '"harness":"claude","harne\\u0073s":"claude"'),
);
rawBad('over-frame', requestRaw + ' '.repeat(65537 - Buffer.byteLength(requestRaw)));
rawBad('over-frame-multibyte', `${requestRaw.slice(0, -1)},"extra":"${'é'.repeat(32768)}"}`);
const nonScalar = requestRaw.replace('session-🌱', String.fromCharCode(0xd800));
negative.push({
  name: 'raw-lone-surrogate',
  units: Array.from({ length: nonScalar.length }, (_, i) => nonScalar.charCodeAt(i)),
  ingress: uncorrelatable,
});
rawBad('partial', requestRaw.slice(0, -1));
rawBad('trailing', `${requestRaw} trailing`);
rawBad('bom', `\ufeff${requestRaw}`);
rawBad('nested-depth', `${requestRaw.slice(0, -1)},"extra":${'['.repeat(40)}0${']'.repeat(40)}}`);
for (const type of [
  'image_insert_unknown',
  'image_upload_complete',
  'hello',
  'IMAGE_INSERT_REQUEST',
])
  bad(`wrong-type:${type}`, { ...request, type });
for (const [index, value] of [null, [], true, 1, 'image_insert_request', [request]].entries())
  bad(`root:${index}`, value);
negative.push({
  name: 'invalid-utf8',
  bytes: [...Buffer.from(requestRaw.slice(0, -1)), 255, 125],
  ingress: uncorrelatable,
});
negative.push({ name: 'invalid-utf8-overlong', bytes: [0xc0, 0xaf], ingress: uncorrelatable });
const corpus = {
  contract: 'ADR0042',
  protocolVersion: 1,
  scope: 'Structural validation only; no authority, effects or advertised capability',
  positive,
  negative,
};
writeFileSync(new URL('./vectors.json', import.meta.url), `${JSON.stringify(corpus, null, 2)}\n`);
console.log(JSON.stringify({ positive: positive.length, negative: negative.length }));
