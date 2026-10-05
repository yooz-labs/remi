import type { ClientApproval } from '@/lib/connection-approval';
import { useState } from 'react';

/** The command is for a local human on the daemon machine, never a remote action. */
export function ApprovalNeeded({
  approval,
  host,
  onRetry,
  retrying = false,
}: {
  readonly approval: ClientApproval;
  readonly host: string;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied`);
    } catch {
      setCopyStatus('Copy unavailable. Select the text to copy it.');
    }
  }
  return (
    <section className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-light)] p-3 text-sm text-[var(--color-text)]">
      <h3 className="font-semibold">
        {approval.status === 'pending' ? 'Approval needed' : 'Approval request failed'}
      </h3>
      <p className="break-words text-xs text-[var(--color-text-secondary)]">{host}</p>
      <p>
        {approval.status === 'pending'
          ? 'On the daemon machine, run remi keys and compare this device fingerprint with the pending request. Approve it locally, then Retry. Requests expire after 10 minutes; retrying does not extend that window.'
          : approval.status === 'queue-full'
            ? 'The pending queue is full. This request was not saved. Try again after a slot becomes available, then compare and approve on the daemon machine.'
            : 'The daemon could not save this approval request. Resolve the storage error on the daemon machine, then retry.'}
      </p>
      {approval.detail && <p className="break-words">{approval.detail}</p>}
      <p>
        Device fingerprint: <code className="select-all">{approval.fingerprint}</code>
      </p>
      {approval.status === 'pending' && (
        <>
          <p className="text-xs">Run on the daemon machine after comparing the fingerprint:</p>
          <code className="block select-all break-all">{approval.authorizeCommand}</code>
          <button
            type="button"
            className="rounded border border-[var(--color-border)] px-3 py-1.5"
            onClick={() => void copy(approval.authorizeCommand, 'Command')}
          >
            Copy command
          </button>
        </>
      )}
      <details>
        <summary>Public identity JSON</summary>
        <pre className="whitespace-pre-wrap break-all text-xs select-all">
          {approval.publicJson}
        </pre>
      </details>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border border-[var(--color-border)] px-3 py-1.5"
          onClick={() => void copy(approval.publicJson, 'Public JSON')}
        >
          Copy public JSON
        </button>
        {onRetry && (
          <button
            type="button"
            disabled={retrying}
            className="rounded bg-[var(--color-primary)] px-3 py-1.5 text-[var(--color-accent-ink)] disabled:opacity-50"
            onClick={onRetry}
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
      </div>
      {copyStatus && <output className="block text-xs">{copyStatus}</output>}
    </section>
  );
}
