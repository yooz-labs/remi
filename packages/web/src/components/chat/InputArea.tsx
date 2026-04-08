/**
 * InputArea component.
 *
 * Chat input with expanding textarea, send button, and quick actions.
 */

import type { UIQuestion } from '@/types';
import { hapticImpact } from '@/lib/haptics';
import { clsx } from 'clsx';
import { Send, StopCircle } from 'lucide-react';
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
  readonly onCancel?: () => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly question?: UIQuestion | null;
  readonly isAgentBusy?: boolean;
  readonly className?: string;
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
        variant === 'primary' && 'bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-dark)]',
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
  onCancel,
  disabled = false,
  placeholder = 'Type a message...',
  question,
  isAgentBusy = false,
  className,
}: InputAreaProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);

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

  // Handle quick response
  const handleQuickResponse = (response: string) => {
    onSend(response);
  };

  // Determine if we should show quick responses
  const showQuickResponses = question && !isAgentBusy;

  return (
    <div
      ref={containerRef}
      className={clsx(
        'border-t border-[var(--color-border)] bg-[var(--color-surface)]',
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

      {/* Cancel button when agent is busy */}
      {isAgentBusy && onCancel && (
        <div className="flex justify-center border-b border-[var(--color-border)] py-2">
          <button
            onClick={onCancel}
            className="flex items-center gap-2 rounded-full bg-[var(--color-error)]/10 px-4 py-1.5 text-sm text-[var(--color-error)] transition-colors hover:bg-[var(--color-error)]/20"
          >
            <StopCircle className="size-4" />
            Stop
          </button>
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
              'w-full resize-none rounded-2xl bg-[var(--color-surface-light)] px-4 py-2.5',
              'text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]',
              'outline-none transition-colors',
              'focus:ring-2 focus:ring-[var(--color-primary)]/50',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          />
        </div>

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={disabled || !value.trim()}
          className={clsx(
            'rounded-full p-2.5 transition-all',
            value.trim()
              ? 'bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-dark)] active:scale-95'
              : 'text-[var(--color-text-muted)]',
            disabled && 'cursor-not-allowed opacity-50',
          )}
          aria-label="Send message"
        >
          <Send className="size-5" />
        </button>
      </div>
    </div>
  );
}
