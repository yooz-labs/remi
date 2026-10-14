import type { BrowserLinksState } from '@/lib/browser-links';
export interface BrowserLinksProps {
  readonly state: BrowserLinksState;
  readonly onReceive: () => void;
  readonly onStop: () => void;
  readonly onOpen: (id: string) => void;
}
const labels: Record<BrowserLinksState['phase'], string> = {
  unavailable:
    'Browser links require a verified direct TLS connection to an attached Claude session in this web app.',
  ready: 'Choose where this session sends browser links. Each destination needs your Open click.',
  pending: 'Receiver request pending…',
  receiving: 'Receiving browser links here. Destinations expire after two minutes.',
  replaced: 'Another receiver was selected.',
  uncertain: 'Receiver outcome unknown. Choose Receive again to make a new request.',
  expired: 'The previous destinations expired. Still receiving here.',
};
export function BrowserLinks({ state, onReceive, onStop, onOpen }: BrowserLinksProps) {
  return (
    <section
      aria-label="Browser links"
      className="max-h-64 shrink-0 overflow-y-auto border-t border-[var(--color-border)] px-4 py-3 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <strong className="mr-auto">Browser links</strong>
        <button
          type="button"
          disabled={state.phase === 'unavailable' || state.phase === 'pending'}
          onClick={onReceive}
          className="rounded-lg border border-[var(--color-border)] px-3 py-2 disabled:opacity-50"
        >
          Receive browser links here
        </button>
        {['receiving', 'expired', 'pending'].includes(state.phase) && (
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2"
          >
            Stop receiving
          </button>
        )}
      </div>
      <p role="status" className="mt-2 text-[var(--color-text-muted)]">
        {labels[state.phase]}
      </p>
      {state.error && (
        <p role="alert" className="mt-2">
          {state.error}
        </p>
      )}
      {state.candidates.map((candidate) => (
        <div key={candidate.id} className="mt-3 rounded-lg border border-[var(--color-border)] p-3">
          <div className="sticky top-0 mb-2 flex items-center justify-between gap-2 bg-[var(--color-surface)] py-1">
            <span>Destination · scroll to review</span>
            <button
              type="button"
              onClick={() => onOpen(candidate.id)}
              className="rounded-lg border border-[var(--color-border)] px-4 py-2"
            >
              Open
            </button>
          </div>
          <p className="whitespace-pre-wrap break-all" data-browser-destination>
            {candidate.url}
          </p>
        </div>
      ))}
    </section>
  );
}
