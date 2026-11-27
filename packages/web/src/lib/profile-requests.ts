import { hubSupport } from '@remi/shared';
import {
  createCreateSessionRequest,
  createSessionProfilesRequest,
} from '@remi/shared/protocol.ts';
import type { ProtocolMessage } from '@remi/shared/protocol.ts';
import type { UUID } from '@remi/shared/types.ts';

type CapabilitySnapshot = {
  readonly protocolVersion?: unknown;
  readonly capabilities?: readonly string[];
};

type SendProtocolMessage = (message: ProtocolMessage) => boolean;

/** Send a profile lookup only when the connection advertises the request capability. */
export function sendSessionProfilesRequest(
  connection: CapabilitySnapshot,
  send: SendProtocolMessage,
  directory?: string,
): UUID | null {
  if (!hubSupport(connection, ['session_profiles']).supported) return null;
  const request = createSessionProfilesRequest(directory);
  return send(request) ? request.id : null;
}

/** Preserve legacy create frames unless the profile capability authorizes a profile choice. */
export function sendNewSessionRequest(
  connection: CapabilitySnapshot,
  send: SendProtocolMessage,
  directory?: string,
  options?: { readonly profile?: string | undefined },
): UUID | null {
  const supportsProfiles = hubSupport(connection, ['session_profiles']).supported;
  const request = createCreateSessionRequest(
    directory,
    supportsProfiles && options?.profile !== undefined
      ? { harness: 'claude', profile: options.profile }
      : {},
  );
  return send(request) ? request.id : null;
}
