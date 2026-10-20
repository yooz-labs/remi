/** Browser-links selection and producer over the shared owned relay App fixture. */
import { basename } from 'node:path';
import { createIdentity, unlockIdentity } from '@remi/shared';
import type { PTYSession } from '../../../daemon/src/pty/pty-session.ts';
import { relayBrowserFixture } from '../../../daemon/tests/helpers/browser-link-service-fixture.ts';
import {
  type OwnedRelayAppResources as AppResources,
  ownedRelayAppFixture,
} from './owned-relay-app-fixture.ts';

export interface OwnedRelayAppResources extends AppResources {
  readonly launcher: string;
  readonly consumer: PTYSession;
}

export async function relayBrowserLinkAppFixture(
  artifact: string,
  options: {
    closePageAfterNavigation?: boolean;
    observe?: (resources: OwnedRelayAppResources) => void;
  } = {},
) {
  const replacementIdentity = await unlockIdentity(await createIdentity());
  const relay = await relayBrowserFixture([replacementIdentity]);
  const { ready: panel, ...app } = await ownedRelayAppFixture(artifact, relay, {
    closePageAfterNavigation: options.closePageAfterNavigation,
    observe: (resources) =>
      options.observe?.({
        ...resources,
        launcher: relay.producer.browserPath,
        consumer: relay.pty,
      }),
    async ready(page) {
      const session = relay.registry
        .listSessions()
        .find((item) => item.sessionId === relay.sessionId);
      if (!session?.name) throw Error('Owned actual session missing');
      await page
        .getByText(basename(session.projectPath), { exact: true })
        .first()
        .click({ timeout: 20000 });
      const panel = page.getByRole('region', { name: 'Browser links', exact: true });
      await panel
        .getByRole('button', { name: 'Receive browser links here', exact: true })
        .waitFor({ timeout: 20000 });
      return panel;
    },
  });
  return {
    ...app,
    replacementIdentity,
    panel,
    async offer(url: string) {
      const child = Bun.spawn([relay.producer.browserPath, url], {
        env: relay.files.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exit !== 0 || stdout || stderr) throw Error('Actual owned producer did not accept URL');
    },
  };
}
