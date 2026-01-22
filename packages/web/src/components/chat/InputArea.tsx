/**
 * InputArea component.
 *
 * Chat input with expanding textarea, send button, and quick actions.
 */

import type { UIQuestion } from '@/types';
import { clsx } from 'clsx';
import { Mic, Paperclip, Send, StopCircle } from 'lucide-react';
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
          'bg-[--color-surface-elevated] text-[--color-text] hover:bg-[--color-surface-light]',
        variant === 'primary' && 'bg-[--color-primary] text-white hover:bg-[--color-primary-dark]',
        variant === 'danger' &&
          'bg-[--color-error]/10 text-[--color-error] hover:bg-[--color-error]/20',
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
  const sendingRef = useRef(false);

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
      className={clsx(
        'border-t border-[--color-border] bg-[--color-surface]',
        'safe-area-bottom',
        className,
      )}
    >
      {/* Quick responses for questions */}
      {showQuickResponses && (
        <div className="border-b border-[--color-border] px-4 py-3">
          <p className="mb-2 text-sm text-[--color-text-secondary]">{question.prompt}</p>
          <div className="flex flex-wrap gap-2">
            {question.type === 'yes_no' && (
              <>
                <QuickResponse
                  label="Yes"
                  onClick={() => handleQuickResponse('yes')}
                  variant="primary"
                />
                <QuickResponse
                  label="No"
                  onClick={() => handleQuickResponse('no')}
                  variant="danger"
                />
              </>
            )}
            {question.type === 'numbered' &&
              question.options?.map((option, index) => (
                <QuickResponse
                  key={index}
                  label={`${index + 1}. ${option}`}
                  onClick={() => handleQuickResponse(String(index + 1))}
                />
              ))}
            {question.type === 'permission' && (
              <>
                <QuickResponse
                  label="Allow"
                  onClick={() => handleQuickResponse('allow')}
                  variant="primary"
                />
                <QuickResponse
                  label="Deny"
                  onClick={() => handleQuickResponse('deny')}
                  variant="danger"
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* Cancel button when agent is busy */}
      {isAgentBusy && onCancel && (
        <div className="flex justify-center border-b border-[--color-border] py-2">
          <button
            onClick={onCancel}
            className="flex items-center gap-2 rounded-full bg-[--color-error]/10 px-4 py-1.5 text-sm text-[--color-error] transition-colors hover:bg-[--color-error]/20"
          >
            <StopCircle className="size-4" />
            Stop
          </button>
        </div>
      )}

      {/* Input row */}
      <div className="flex items-end gap-2 p-3">
        {/* Attachment button (future) */}
        <button
          className="rounded-full p-2 text-[--color-text-muted] transition-colors hover:bg-[--color-surface-light] hover:text-[--color-text]"
          aria-label="Attach file"
          disabled
        >
          <Paperclip className="size-5" />
        </button>

        {/* Text input */}
        <div className="relative flex-1">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={clsx(
              'w-full resize-none rounded-2xl bg-[--color-surface-light] px-4 py-2.5',
              'text-sm text-[--color-text] placeholder:text-[--color-text-muted]',
              'outline-none transition-colors',
              'focus:ring-2 focus:ring-[--color-primary]/50',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          />
        </div>

        {/* Send / Voice button */}
        {value.trim() ? (
          <button
            onClick={handleSend}
            disabled={disabled}
            className={clsx(
              'rounded-full bg-[--color-primary] p-2.5 text-white',
              'transition-all hover:bg-[--color-primary-dark]',
              'active:scale-95',
              disabled && 'cursor-not-allowed opacity-50',
            )}
            aria-label="Send message"
          >
            <Send className="size-5" />
          </button>
        ) : (
          <button
            className="rounded-full p-2.5 text-[--color-text-muted] transition-colors hover:bg-[--color-surface-light] hover:text-[--color-text]"
            aria-label="Voice input"
            disabled
          >
            <Mic className="size-5" />
          </button>
        )}
      </div>
    </div>
  );
}
