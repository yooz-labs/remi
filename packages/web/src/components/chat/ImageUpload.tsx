import { AlertCircle, CheckCircle2, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg']);

export interface ImageDraftState {
  readonly phase:
    | 'available'
    | 'inserting'
    | 'inserted'
    | 'send_requested'
    | 'submitting'
    | 'send_uncertain'
    | 'refused'
    | 'uncertain'
    | 'expired'
    | 'unavailable';
  readonly expiresAt: string;
  readonly requiresAbandonment: boolean;
  readonly message: string;
  readonly action: 'insert' | 'check' | null;
}

export type ImageUploadState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'preparing' | 'checking' | 'cancelling';
      readonly filename: string;
    }
  | {
      readonly phase: 'uploading';
      readonly filename: string;
      readonly uploadedBytes: number;
      readonly totalBytes: number;
    }
  | {
      readonly phase: 'staged';
      readonly filename: string;
      readonly draft?: ImageDraftState;
    }
  | {
      readonly phase: 'failed' | 'uncertain';
      readonly filename: string;
      readonly message: string;
    };

interface ImageUploadProps {
  readonly enabled: boolean;
  readonly state: ImageUploadState;
  readonly onSelect: (file: File) => void;
  readonly onCancel: () => void;
  readonly onDismiss: () => void;
  readonly onAddToDraft?: () => void;
  readonly onAbandonDraft?: () => void;
}

const ACTIVE_PHASES = new Set(['preparing', 'uploading', 'checking', 'cancelling']);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function isActive(state: ImageUploadState): boolean {
  return ACTIVE_PHASES.has(state.phase);
}

/** Existing image picker plus explicit draft action; Send remains a separate choice. */
export function ImageUpload({
  enabled,
  state,
  onSelect,
  onCancel,
  onDismiss,
  onAddToDraft,
  onAbandonDraft,
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const active =
    isActive(state) ||
    (state.phase === 'staged' && ['inserting', 'submitting'].includes(state.draft?.phase ?? ''));
  const disabled = !enabled || active;
  useEffect(() => {
    if (
      state.phase !== 'staged' ||
      !state.draft?.requiresAbandonment ||
      ['inserting', 'submitting'].includes(state.draft.phase)
    ) {
      setConfirmClear(false);
    }
  }, [state]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Clearing the input lets the user choose the same file again after a retry.
    input.value = '';
    if (!file || !enabled || active) return;

    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setSelectionError('Choose a PNG or JPEG image.');
      return;
    }
    if (file.size === 0) {
      setSelectionError('This image is empty. Choose a different file.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setSelectionError('Images must be 10 MiB or smaller. Choose a smaller file.');
      return;
    }

    setSelectionError(null);
    onSelect(file);
  };

  const pickButton = (
    <button
      type="button"
      disabled={disabled}
      onClick={() => inputRef.current?.click()}
      className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-semibold text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <ImagePlus aria-hidden="true" className="size-4" />
      Upload image
    </button>
  );

  return (
    <section
      aria-label="Image upload"
      className="border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 sm:px-4"
    >
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept="image/png,image/jpeg"
        onChange={handleFileChange}
        tabIndex={-1}
        aria-hidden="true"
      />

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <ImagePlus aria-hidden="true" className="size-4 shrink-0 text-[var(--color-primary)]" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--color-text)]">Upload an image</p>
            <p className="text-[11px] leading-4 text-[var(--color-text-muted)]">
              PNG or JPEG · up to 10 MiB
            </p>
          </div>
        </div>

        {state.phase === 'idle' && pickButton}

        {(state.phase === 'preparing' || state.phase === 'checking') && (
          <div className="flex min-w-0 flex-1 basis-full items-center gap-2 text-xs text-[var(--color-text-secondary)] sm:basis-auto">
            <LoaderCircle
              aria-hidden="true"
              className="size-4 shrink-0 animate-spin text-[var(--color-primary)]"
            />
            <span className="min-w-0 flex-1 truncate">
              {state.phase === 'preparing' ? 'Preparing image…' : 'Checking uploaded image…'}
              <span className="ml-1 text-[var(--color-text-muted)]">{state.filename}</span>
            </span>
            <button
              type="button"
              onClick={onCancel}
              className="shrink-0 rounded-md px-2 py-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            >
              Cancel
            </button>
          </div>
        )}

        {state.phase === 'uploading' &&
          (() => {
            const totalBytes = Math.max(0, state.totalBytes);
            const uploadedBytes = Math.max(0, Math.min(state.uploadedBytes, totalBytes));
            const progress = totalBytes > 0 ? Math.round((uploadedBytes / totalBytes) * 100) : 0;
            return (
              <div className="flex min-w-0 flex-1 basis-full items-center gap-3 sm:basis-auto">
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]">
                    <span className="min-w-0 truncate text-[var(--color-text-secondary)]">
                      Uploading {state.filename}
                    </span>
                    <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">
                      {formatBytes(uploadedBytes)} / {formatBytes(totalBytes)}
                    </span>
                  </div>
                  <div
                    role="progressbar"
                    tabIndex={0}
                    aria-label={`Uploading ${state.filename}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                    aria-valuetext={`${progress}% uploaded`}
                    className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-elevated)]"
                  >
                    <div
                      className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-200"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onCancel}
                  className="shrink-0 rounded-md px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                >
                  Cancel
                </button>
              </div>
            );
          })()}

        {state.phase === 'cancelling' && (
          <output className="flex min-w-0 flex-1 basis-full items-center gap-2 text-xs text-[var(--color-text-secondary)] sm:basis-auto">
            <LoaderCircle
              aria-hidden="true"
              className="size-4 shrink-0 animate-spin text-[var(--color-warning)]"
            />
            <span className="min-w-0 truncate">Cancelling upload · {state.filename}</span>
          </output>
        )}

        {state.phase === 'staged' && (
          <div className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-2">
            <output className="flex min-w-0 flex-1 items-start gap-2 text-xs">
              {state.draft?.phase === 'inserting' ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 animate-spin text-[var(--color-primary)]"
                />
              ) : (
                <CheckCircle2
                  aria-hidden="true"
                  className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]"
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[var(--color-text)]">
                  {state.filename}
                </span>
                <span className="mt-0.5 block break-words text-[var(--color-text-secondary)]">
                  {state.draft?.message ?? 'Image uploaded.'}
                </span>
                {state.draft && state.draft.phase !== 'expired' && (
                  <span className="mt-0.5 block text-[var(--color-text-muted)]">
                    Send before{' '}
                    <time dateTime={state.draft.expiresAt}>
                      {new Date(state.draft.expiresAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </time>{' '}
                    · before this session ends.
                    {state.draft.phase === 'available' &&
                      ' Add to draft first, then Send when ready.'}
                  </span>
                )}
              </span>
            </output>
            <div className="flex w-full flex-wrap items-center gap-2 pl-6 sm:w-auto sm:pl-0">
              {state.draft?.action && onAddToDraft && (
                <button
                  type="button"
                  onClick={onAddToDraft}
                  className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[var(--color-primary)] px-3 py-2 text-xs font-semibold text-[var(--color-accent-ink)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
                >
                  {state.draft.action === 'check' ? 'Check status' : 'Add to draft'}
                </button>
              )}
              {pickButton}
              <button
                type="button"
                disabled={active}
                aria-label="Dismiss image upload status"
                onClick={() => {
                  if (state.draft?.requiresAbandonment) setConfirmClear(true);
                  else onDismiss();
                }}
                className="min-h-11 rounded-md p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] disabled:opacity-50"
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </div>
          </div>
        )}

        {(state.phase === 'failed' || state.phase === 'uncertain') && (
          <div
            role="alert"
            className="flex min-w-0 flex-1 basis-full items-start gap-2 text-xs sm:basis-auto"
          >
            <AlertCircle
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-[var(--color-warning)]"
            />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-[var(--color-text)]">
                {state.phase === 'failed' ? 'Image upload failed' : 'Upload status is unclear'}
              </p>
              <p className="break-words text-[var(--color-text-muted)]">{state.message}</p>
              <p className="mt-0.5 truncate text-[var(--color-text-muted)]">{state.filename}</p>
            </div>
            <button
              type="button"
              aria-label="Dismiss image upload status"
              onClick={onDismiss}
              className="shrink-0 rounded-md p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-light)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          </div>
        )}
      </div>

      {confirmClear && state.phase === 'staged' && state.draft?.requiresAbandonment && (
        <fieldset
          className="mt-3 min-w-0 rounded-lg border border-[var(--color-border)] p-3 text-xs"
          aria-label="Clear image status"
        >
          <p className="text-[var(--color-text-secondary)]">
            Clearing this status does not remove any image reference from the terminal draft. Its
            file expires at{' '}
            <time dateTime={state.draft.expiresAt}>
              {new Date(state.draft.expiresAt).toLocaleString()}
            </time>
            . Check the session and remove any unsent reference before uploading again.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setConfirmClear(false)}
              className="min-h-11 rounded-lg border border-[var(--color-border)] px-3 font-semibold text-[var(--color-text)]"
            >
              Keep status
            </button>
            <button
              type="button"
              disabled={!onAbandonDraft}
              onClick={() => {
                setConfirmClear(false);
                onAbandonDraft?.();
              }}
              className="min-h-11 rounded-lg px-3 font-semibold text-[var(--color-text-secondary)]"
            >
              Clear status
            </button>
          </div>
        </fieldset>
      )}

      {state.phase === 'idle' && !enabled && (
        <p className="mt-1 pl-6 text-[11px] text-[var(--color-text-muted)]">
          Image upload is unavailable for this connection.
        </p>
      )}
      {selectionError && (
        <p role="alert" className="mt-2 text-xs text-[var(--color-warning)]">
          {selectionError}
        </p>
      )}
    </section>
  );
}
