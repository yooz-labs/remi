import { AlertCircle, CheckCircle2, Download, FileDown, LoaderCircle, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { FileDownloadState } from '@/lib/file-download';

export interface FileDownloadProps {
  /** Current authenticated transport, child attachment and capability readiness. */
  readonly available: boolean;
  readonly canCancel: boolean;
  readonly unavailableMessage?: string;
  readonly state: FileDownloadState;
  readonly saveMessage?: string | null;
  readonly onDownload: (relativePath: string) => void;
  readonly onCancel: () => void;
  readonly onDismiss: () => void;
  readonly onSave: () => void;
  readonly onReleaseSave: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const quietButton =
  'inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50';
const actionButton =
  'inline-flex min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50';

/** Explicit project-file request and Save controls; no content preview or automatic action. */
export function FileDownload({
  available,
  canCancel,
  unavailableMessage,
  state,
  saveMessage,
  onDownload,
  onCancel,
  onDismiss,
  onSave,
  onReleaseSave,
}: FileDownloadProps) {
  const [relativePath, setRelativePath] = useState('');
  const releaseSave = useRef(onReleaseSave);
  useEffect(() => {
    releaseSave.current = onReleaseSave;
  }, [onReleaseSave]);
  useEffect(() => () => releaseSave.current(), []);
  const busy = ['preparing', 'receiving', 'verifying', 'finishing', 'cancelling'].includes(
    state.phase,
  );
  const canRequest = available && !busy && state.phase !== 'ready';
  const progress =
    state.phase === 'receiving' || state.phase === 'verifying' || state.phase === 'finishing'
      ? state
      : null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Preserve the exact path spelling; the host owns filesystem admission.
    if (canRequest && relativePath.length > 0) onDownload(relativePath);
  };

  return (
    <section
      aria-label="File download"
      className="max-h-64 shrink-0 overflow-y-auto border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 sm:px-4"
    >
      <div className="mb-2 flex items-center gap-2">
        <FileDown aria-hidden="true" className="size-4 shrink-0 text-[var(--color-primary)]" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-[var(--color-text)]">Download a project file</p>
          <p className="text-[11px] leading-4 text-[var(--color-text-muted)]">
            One file · up to 10 MiB · Save when verified
          </p>
        </div>
      </div>

      {state.phase !== 'ready' && (
        <form onSubmit={submit} className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 basis-48 text-[11px] text-[var(--color-text-secondary)]">
            File path in project
            <input
              type="text"
              value={relativePath}
              onChange={(event) => setRelativePath(event.currentTarget.value)}
              disabled={!canRequest}
              required
              maxLength={4096}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="reports/result.csv"
              className="mt-1 block min-h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-xs text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-primary)] disabled:opacity-60"
            />
          </label>
          <button
            type="submit"
            disabled={!canRequest || relativePath.length === 0}
            className={actionButton}
          >
            <Download aria-hidden="true" className="size-3.5" />
            Download
          </button>
        </form>
      )}

      {!available && !busy && state.phase !== 'ready' && (
        <p className="mt-2 text-[11px] leading-4 text-[var(--color-text-muted)]">
          {unavailableMessage ?? 'File downloads are unavailable for this session.'}
        </p>
      )}

      {busy && (
        <div
          role="status"
          className="mt-2 flex min-w-0 items-start gap-2 text-xs text-[var(--color-text-secondary)]"
        >
          <LoaderCircle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--color-primary)]"
          />
          <div className="min-w-0 flex-1">
            <p>
              {state.phase === 'preparing'
                ? 'Preparing file…'
                : state.phase === 'receiving'
                  ? 'Receiving file…'
                  : state.phase === 'verifying'
                    ? 'Verifying file…'
                    : state.phase === 'finishing'
                      ? 'Confirming host cleanup…'
                      : 'Cancelling download…'}
            </p>
            {state.phase === 'preparing' && (
              <p className="mt-1 break-all text-[11px] text-[var(--color-text-muted)]">
                {state.relativePath}
              </p>
            )}
            {progress && (
              <>
                <p className="mt-1 break-all text-[11px] text-[var(--color-text-muted)]">
                  {progress.fileName}
                </p>
                <progress
                  aria-label="Received file bytes"
                  value={progress.receivedBytes}
                  max={progress.byteLength}
                  className="mt-1 h-1.5 w-full accent-[var(--color-primary)]"
                />
                <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                  {formatBytes(progress.receivedBytes)} of {formatBytes(progress.byteLength)}
                </p>
              </>
            )}
          </div>
          {state.phase !== 'cancelling' && (
            <button type="button" onClick={onCancel} disabled={!canCancel} className={quietButton}>
              Cancel
            </button>
          )}
        </div>
      )}

      {state.phase === 'ready' && (
        <div role="status" className="flex min-w-0 flex-wrap items-start gap-2 text-xs">
          <CheckCircle2
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-[var(--color-primary)]"
          />
          <div className="min-w-0 flex-1 basis-40">
            <p className="break-all font-medium text-[var(--color-text)]">{state.fileName}</p>
            <p className="mt-1 text-[11px] leading-4 text-[var(--color-text-muted)]">
              {formatBytes(state.byteLength)} · {state.message}
            </p>
            {saveMessage && (
              <p className="mt-1 text-[11px] leading-4 text-[var(--color-text-secondary)]">
                {saveMessage}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-1">
            <button type="button" onClick={onSave} disabled={!available} className={actionButton}>
              <Download aria-hidden="true" className="size-3.5" />
              Save
            </button>
            <button type="button" onClick={onCancel} className={quietButton}>
              Discard
            </button>
          </div>
        </div>
      )}

      {(state.phase === 'failed' || state.phase === 'cancelled') && (
        <div
          role={state.phase === 'failed' ? 'alert' : 'status'}
          className="mt-2 flex min-w-0 items-start gap-2 text-xs text-[var(--color-text-secondary)]"
        >
          <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <p className="min-w-0 flex-1 break-words leading-5">{state.message}</p>
          {state.phase === 'failed' && canCancel && (
            <button type="button" onClick={onCancel} className={quietButton}>
              Cancel transfer
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss download message"
            className={quietButton}
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      )}
    </section>
  );
}
