/**
 * InputArea component.
 *
 * Chat input with expanding textarea, send button, and quick actions.
 */

import { hapticImpact } from '@/lib/haptics';
import { type ReplyContext, previewText } from '@/lib/reply-format';
import type { UIQuestion } from '@/types';
import { clsx } from 'clsx';
import { CornerUpLeft, Send, StopCircle, X } from 'lucide-react';
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

interface InputAreaProps {
  readonly onSend: (message: string) => void;
  /** Answer the active question (#401). Quick-response chips route here so
   *  tapping Yes/No on a 2-option permission sends `sendAnswer` not the
   *  literal "y"/"n" via `sendInput`. Required when `question` is set
   *  with options (the chips are visible). */
  readonly onAnswer?: (answer: string) => void;
  readonly onCancel?: () => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly question?: UIQuestion | null;
  readonly isAgentBusy?: boolean;
  readonly className?: string;
  /** When set, render the reply banner above the input and submit the
   *  message wrapped in a markdown blockquote (#401). The wire-format
   *  wrap happens in App.tsx#handleSend so this component only owns
   *  the visual banner + clear affordance. */
  readonly replyContext?: ReplyContext | null;
  readonly onClearReply?: () => void;
  /**
   * When provided, the typed-but-unsent draft is persisted to localStorage
   * under this key and restored across reloads / app suspensions. Pass a
   * session-scoped value (e.g. `remi-draft-${sessionId}`) so drafts don't
   * leak between sessions. Issue #226: iOS dropped the draft when the app
   * was backgrounded; persistence + hydration fixes that.
   */
  readonly draftKey?: string;
}

/** Quick response button for yes/no and numbered options */
function QuickResponse({
  label,
  onClick,
  variant = 'default',
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly variant?: 'default' | 'primary' | 'danger';
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'rounded-full px-4 py-2 text-sm font-medium transition-colors',
        variant === 'default' &&
          'bg-[var(--color-surface-elevated)] text-[var(--color-text)] hover:bg-[var(--color-surface-light)]',
        variant === 'primary' &&
          'bg-[var(--color-primary)] text-[var(--color-accent-ink)] hover:bg-[var(--color-primary-dark)]',
        variant === 'danger' &&
          'bg-[var(--color-error)]/10 text-[var(--color-error)] hover:bg-[var(--color-error)]/20',
      )}
    >
      {label}
    </button>
  );
}

export function InputArea({
  onSend,
  onAnswer,
  onCancel,
  disabled = false,
  placeholder = 'Type a message...',
  question,
  isAgentBusy = false,
  className,
  replyContext,
  onClearReply,
  draftKey,
}: InputAreaProps) {
  // Hydrate draft from localStorage when a draftKey is provided. The lazy
  // initializer runs only on mount; subsequent draftKey changes (session
  // switches) re-hydrate via the effect below.
  const [value, setValue] = useState<string>(() => {
    if (!draftKey) return '';
    try {
      return localStorage.getItem(draftKey) ?? '';
    } catch {
      return '';
    }
  });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  // Long-press on the send button opens the Stop dialog (#624 review): hold to
  // confirm sending Esc to the session. `longPressedRef` suppresses the click
  // that follows the release so the long-press doesn't also send the message.
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressedRef = useRef(false);
  const [stopDialogOpen, setStopDialogOpen] = useState(false);

  // Re-hydrate when the active session (and therefore draftKey) changes.
  useEffect(() => {
    if (!draftKey) return;
    try {
      setValue(localStorage.getItem(draftKey) ?? '');
    } catch {
      setValue('');
    }
  }, [draftKey]);

  // Persist on every keystroke. Empty drafts remove the key so localStorage
  // doesn't grow unboundedly with one entry per session that was once
  // visited.
  useEffect(() => {
    if (!draftKey) return;
    try {
      if (value) {
        localStorage.setItem(draftKey, value);
      } else {
        localStorage.removeItem(draftKey);
      }
    } catch {
      // Storage may be full or disabled (private mode); drop silently.
    }
  }, [value, draftKey]);

  // Scroll input into view when focused on iOS (keyboard pushes content up)
  const handleFocus = useCallback(() => {
    requestAnimationFrame(() => {
      containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
  }, []);

  // Auto-resize textarea
  const adjustHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const newHeight = Math.min(textarea.scrollHeight, 150);
    textarea.style.height = `${newHeight}px`;
  }, []);

  useEffect(() => {
    adjustHeight();
  }, [value, adjustHeight]);

  // Handle input change - ignore if we're in the process of sending
  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    if (sendingRef.current) {
      return;
    }
    setValue(e.target.value);
  };

  // Handle key press - send on Enter, allow Shift+Enter for newlines
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();

      const trimmed = value.trim();
      if (!trimmed || disabled) {
        return;
      }

      // Set flag to block onChange during send
      sendingRef.current = true;

      // Send message
      hapticImpact('light');
      onSend(trimmed);

      // Clear input
      setValue('');

      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }

      // Reset flag after a brief delay
      setTimeout(() => {
        sendingRef.current = false;
      }, 50);
    }
  };

  // Handle send (for button click)
  const handleSend = () => {
    // Suppress the click that follows a long-press (which fired the escape).
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    const trimmed = value.trim();
    if (!trimmed || disabled) {
      return;
    }

    hapticImpact('light');
    onSend(trimmed);
    setValue('');

    // Reset height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  // #624 review: the escape — send Esc to the session (interrupt running work /
  // cancel an on-screen prompt). Confirmed via the Stop dialog so it can never
  // fire accidentally.
  const confirmStop = useCallback(() => {
    setStopDialogOpen(false);
    if (!onCancel) return;
    hapticImpact('medium');
    onCancel();
  }, [onCancel]);

  // Long-press the send button (the one button) opens the Stop dialog. Works
  // whether or not there is text, so it's available exactly when Claude is busy
  // and the input is empty.
  const startLongPress = useCallback(() => {
    longPressedRef.current = false;
    if (!onCancel || disabled) return;
    longPressTimer.current = setTimeout(() => {
      longPressedRef.current = true;
      hapticImpact('medium');
      setStopDialogOpen(true);
    }, 450);
  }, [onCancel, disabled]);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Clear any pending long-press timer on unmount.
  useEffect(() => () => cancelLongPress(), [cancelLongPress]);

  // Quick-response chips for an active question. Route through onAnswer so
  // a tap on Yes/No/option-N is a real `sendAnswer`, not the literal value
  // sent as a regular user input (#401 / #402 review). When onAnswer is
  // not provided (e.g. consumer hasn't migrated yet), fall back to onSend
  // to preserve the prior behavior; this branch is only reachable when the
  // chips are rendered, which itself requires `question` to be set.
  const handleQuickResponse = (response: string) => {
    (onAnswer ?? onSend)(response);
  };

  // Determine if we should show quick responses
  const showQuickResponses = question && !isAgentBusy;

  return (
    <div
      ref={containerRef}
      className={clsx(
        'relative border-t border-[var(--color-border)] bg-[var(--color-surface)]',
        'safe-area-bottom',
        className,
      )}
    >
      {/* Quick responses for questions */}
      {showQuickResponses && (
        <div className="border-b border-[var(--color-border)] px-4 py-3">
          <p className="mb-2 text-sm text-[var(--color-text-secondary)]">{question.prompt}</p>
          <div className="flex flex-wrap gap-2">
            {question.structuredOptions && question.structuredOptions.length > 0
              ? question.structuredOptions.map((opt, index) => (
                  <QuickResponse
                    key={index}
                    label={opt.label}
                    onClick={() => handleQuickResponse(opt.value)}
                    variant={opt.isYes ? 'primary' : opt.isNo ? 'danger' : 'default'}
                  />
                ))
              : question.type === 'yes_no' && (
                  <>
                    <QuickResponse
                      label="Yes"
                      onClick={() => handleQuickResponse('y')}
                      variant="primary"
                    />
                    <QuickResponse
                      label="No"
                      onClick={() => handleQuickResponse('n')}
                      variant="danger"
                    />
                  </>
                )}
          </div>
        </div>
      )}

      {/* Reply banner: shown when long-press set a reply context (#401). */}
      {replyContext && (
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-light)] px-4 py-2">
          <CornerUpLeft className="size-4 shrink-0 text-[var(--color-primary)]" />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
              Replying to
            </p>
            <p className="truncate text-xs text-[var(--color-text-secondary)]">
              {previewText(replyContext.content)}
            </p>
          </div>
          {onClearReply && (
            <button
              type="button"
              onClick={onClearReply}
              className="rounded-full p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-elevated)] hover:text-[var(--color-text)]"
              aria-label="Cancel reply"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2 p-3">
        {/* Text input */}
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={clsx(
              'w-full resize-none rounded-[20px] border border-[var(--color-border)] bg-[var(--color-surface-light)] px-4 py-2.5',
              'text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]',
              'outline-none transition-colors',
              'focus:ring-2 focus:ring-[var(--color-primary)]/40',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          />
        </div>

        {/* The one button: tap sends, long-press opens the Stop dialog (#624
            review). Not HTML-`disabled` when the text is empty — only when the
            whole input is disabled — so the long-press escape stays reachable
            while Claude is busy and the field is empty. The empty-state tap is a
            no-op (handled in handleSend); the greyed style signals it. */}
        <button
          onClick={handleSend}
          onPointerDown={startLongPress}
          onPointerUp={cancelLongPress}
          onPointerLeave={cancelLongPress}
          onPointerCancel={cancelLongPress}
          disabled={disabled}
          className={clsx(
            'flex size-10 shrink-0 select-none items-center justify-center rounded-full transition-all',
            value.trim()
              ? 'bg-[var(--color-primary)] text-[var(--color-accent-ink)] hover:bg-[var(--color-primary-dark)] active:scale-95'
              : 'bg-[var(--color-surface-light)] text-[var(--color-text-muted)]',
            disabled && 'cursor-not-allowed opacity-50',
          )}
          aria-label={onCancel ? 'Send message (long-press to stop)' : 'Send message'}
        >
          <Send className="size-5" />
        </button>
      </div>

      {/* Stop dialog (#624 review): the single confirmation surface for the
          escape, reached by long-pressing the send button. Confirming sends a
          bare Esc to interrupt Claude's running work or dismiss a prompt. The
          card is anchored to the input area (absolute, bottom-full) so it rides
          up with the send button when the keyboard pushes the input up; only the
          dim backdrop is fixed to the viewport. */}
      {stopDialogOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setStopDialogOpen(false)}
            role="presentation"
          />
          <div className="absolute inset-x-0 bottom-full z-50 flex justify-center px-4 pb-2">
            <div
              className="w-full max-w-sm rounded-2xl bg-[var(--color-surface-elevated)] p-4 shadow-xl"
              role="dialog"
              aria-modal="true"
              aria-label="Stop the current action"
            >
              <p className="mb-1 text-base font-semibold text-[var(--color-text)]">
                Stop the current action?
              </p>
              <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
                Sends Esc to interrupt Claude's running work or dismiss an on-screen prompt.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStopDialogOpen(false)}
                  className="flex-1 rounded-full bg-[var(--color-surface-light)] py-2.5 text-sm font-medium text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface)] active:scale-95"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={confirmStop}
                  className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[var(--color-error)] py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 active:scale-95"
                >
                  <StopCircle className="size-4" />
                  Stop
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
