/** Strict signed-direct insertion caller; no capability is inferred from a request. */
import { generateId, now } from '@remi/shared';
import type { ImageInsertResult, UUID } from '@remi/shared';
import type { ClientMessageEventsWithConnectionId } from '../../server/client-message-events';
import type { ImageInsertionCoordinator } from '../../tunnel/image-insertion-coordinator';
import type { ImageStagingService } from '../../tunnel/image-staging-service';

interface Host {
  readonly service: () => ImageStagingService | undefined;
  readonly coordinator: () => ImageInsertionCoordinator | undefined;
  readonly send: (connectionId: UUID, result: ImageInsertResult) => void;
}

export function createImageInsertionHandlers(
  host: Host,
): Pick<ClientMessageEventsWithConnectionId, 'onImageInsert'> {
  return {
    async onImageInsert(connectionId, ingress) {
      const service = host.service();
      const coordinator = host.coordinator();
      if (ingress.kind === 'request' && service && coordinator) {
        host.send(connectionId, await coordinator.handle(connectionId, ingress.request));
        return;
      }
      const correlation =
        ingress.kind === 'request'
          ? { requestId: ingress.request.id, sessionId: ingress.request.sessionId }
          : ingress.correlation;
      host.send(connectionId, {
        type: 'image_insert_result',
        id: generateId(),
        timestamp: now(),
        requestId: correlation.requestId,
        sessionId: correlation.sessionId,
        outcome: 'refused',
        code:
          ingress.kind === 'malformed' && service && coordinator
            ? service.insertionMalformedCode(connectionId, ingress.correlation)
            : 'unavailable',
      });
    },
  };
}
