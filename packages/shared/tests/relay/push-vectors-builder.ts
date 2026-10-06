/** Public synthetic seeds/scalars only. No fixture identity is a user's key. */
import * as r from '../../src/relay/internal.ts';
import { hex, seed, text } from './helpers.ts';

export async function buildPushVectors() {
  const machineSeed = seed('push vector machine');
  const deviceSeed = seed('push vector device');
  const recipientScalar = new Uint8Array(32);
  recipientScalar[31] = 7;
  const machine = await r.signerFromSeed(machineSeed);
  const device = await r.signerFromSeed(deviceSeed);
  const recipient = await r.ecPairFromScalar(recipientScalar);
  const kinds = [
    'question',
    'turn_complete',
    'subagent_alert',
    'harness_denied',
    'turn_failed',
    'dismiss',
    'question-reordered',
    'question-yn',
    'question-open-app-setMode',
    'informational-question-no-authority',
  ] as const;
  const cases = [];
  for (let i = 0; i < kinds.length; i++) {
    const name = kinds[i] as (typeof kinds)[number];
    const kind: r.SecurePushKind =
      name.startsWith('question-') || name === 'informational-question-no-authority'
        ? 'question'
        : (name as r.SecurePushKind);
    const content: r.PushContentMetadata = {
      machinePublicKey: r.b64u(machine.publicKey),
      rid: hex(await r.ridOf(machine.publicKey)),
      devicePublicKey: r.b64u(device.publicKey),
      pushPublicKey: r.b64u(recipient.publicKey),
      keyVersion: 3,
      collapseId: r.b64u(seed(`push vector collapse ${i}`).slice(0, 16)),
      revision: 11 + i,
      kind,
      nonce: r.b64u(seed(`push vector content nonce ${i}`)),
      issuedAt: 1700000000,
      expiresAt: 1700000120,
    };
    let payload: r.SecurePushPayload =
      kind === 'dismiss'
        ? { type: 'dismiss', actionable: false }
        : kind === 'question'
          ? {
              type: 'question',
              actionable: true,
              sessionId: 'synthetic-session',
              runtimeInstance: r.b64u(seed('push vector runtime')),
              questionId: 'synthetic-question',
              title: 'Synthetic permission',
              body: 'Complete signed scope',
              category: 'REMI_YNA',
              options: [
                {
                  value: 'allow',
                  label: 'Allow once',
                  isYes: true,
                  isNo: false,
                  description: null,
                  standingGrant: null,
                },
                {
                  value: 'session',
                  label: 'Allow for this session',
                  isYes: true,
                  isNo: false,
                  description: 'Read only the synthetic fixture directory',
                  standingGrant: 'addRules',
                },
                {
                  value: 'deny',
                  label: 'Deny',
                  isYes: false,
                  isNo: true,
                  description: null,
                  standingGrant: null,
                },
              ],
            }
          : {
              type: 'informational',
              actionable: false,
              sessionId: 'synthetic-session',
              title: 'Synthetic event',
              body: 'Open the app',
            };
    if (name === 'informational-question-no-authority')
      payload = {
        type: 'informational',
        actionable: false,
        sessionId: null,
        title: 'Setup required',
        body: 'Open the app',
      };
    if (payload.type === 'question' && name === 'question-yn')
      payload = {
        ...payload,
        category: 'REMI_YN',
        options: payload.options.filter((o) => o.standingGrant === null),
      };
    if (payload.type === 'question' && name === 'question-open-app-setMode')
      payload = {
        ...payload,
        category: 'none',
        options: payload.options.map((o) =>
          o.standingGrant === 'addRules'
            ? {
                ...o,
                value: 'set-mode',
                label: 'Approve with mode change',
                description: 'Change mode for this session only; open the app',
                standingGrant: 'setMode',
              }
            : o,
        ),
      };
    const payloadBytes =
      name === 'question-reordered'
        ? text(
            ` { ${Object.entries(payload)
              .reverse()
              .map(([k, v]) => `${JSON.stringify(k)} : ${JSON.stringify(v)}`)
              .join(', ')} } `,
          )
        : r.buildPushPayload(payload);
    const contentInput = await r.buildPushContentSigningInput(content, payloadBytes);
    const signature = await machine.sign(contentInput);
    const inner = r.encodeSignedPushContent(content, payloadBytes, signature);
    const ephemeralScalar = new Uint8Array(32);
    ephemeralScalar[31] = 21 + i;
    const sealNonce = seed(`push vector seal nonce ${i}`).slice(0, 12);
    const sealed = await r.seal(
      recipient.publicKey,
      r.pushAad(Buffer.from(content.rid, 'hex'), content.collapseId),
      inner,
      () => sealNonce.slice(),
      () => r.ecPairFromScalar(ephemeralScalar),
    );
    // The Worker's view (#1200): no kind, key version, revision or push key; only the class.
    const unsigned: r.UnsignedPushSubmit = {
      v: 2,
      audience: 'https://synthetic.example',
      rid: content.rid,
      machinePublicKey: content.machinePublicKey,
      devicePublicKey: content.devicePublicKey,
      token: 'ab'.repeat(32),
      environment: i % 2 ? 'production' : 'sandbox',
      collapseId: content.collapseId,
      pushClass: r.pushClassOf(content.kind),
      nonce: r.b64u(seed(`push vector submit nonce ${i}`)),
      issuedAt: content.issuedAt,
      expiresAt: 1700000050,
      // APNs may keep the notification until the content itself expires (#1200).
      storeUntil: content.expiresAt,
      sealed: r.b64u(sealed),
    };
    const submitInput = await r.buildPushSubmitSigningInput(unsigned);
    const submit: r.PushSubmit = {
      ...unsigned,
      signature: r.b64u(await machine.sign(submitInput)),
    };
    const proof = await r.verifyPushSubmit(
      submit,
      { rid: content.rid, audience: unsigned.audience },
      1700000001,
    );
    cases.push({
      name,
      content,
      payloadUtf8: new TextDecoder().decode(payloadBytes),
      payloadHex: hex(payloadBytes),
      contentInputHex: hex(contentInput),
      signature: r.b64u(signature),
      innerHex: hex(inner),
      ephemeralScalarHex: hex(ephemeralScalar),
      sealNonceHex: hex(sealNonce),
      sealedHex: hex(sealed),
      submitInputHex: hex(submitInput),
      submit,
      submitJson: r.encodePushSubmit(submit),
      requestDigest: proof.requestDigest,
    });
  }
  return {
    format: 'remi-push-v2-synthetic-1',
    machineSeedHex: hex(machineSeed),
    deviceSeedHex: hex(deviceSeed),
    recipientScalarHex: hex(recipientScalar),
    cases,
  };
}
