/**
 * QuestionCard component.
 *
 * Renders interactive question cards based on question type.
 * Supports yes/no, multi-option, numbered selection, and free text.
 * Designed for mobile with large tap targets (min 44px).
 */

import type { UIQuestion, UIQuestionOption } from '@/types';
import { clsx } from 'clsx';
import { Check, ChevronRight, MessageSquare, Send } from 'lucide-react';
import { type KeyboardEvent, useCallback, useState } from 'react';

interface QuestionCardProps {
  readonly question: UIQuestion;
  readonly onAnswer: (answer: string) => void;
  readonly className?: string;
}

/** Resolve the display label for an option value in the answered state */
function resolveAnswerLabel(question: UIQuestion, answer: string): string {
  if (question.structuredOptions) {
    const match = question.structuredOptions.find((o) => o.value === answer);
    if (match) return match.label;
  }
  if (question.options) {
    // For numbered questions, the answer is the index (1-based)
    const idx = Number.parseInt(answer, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= question.options.length) {
      return question.options[idx - 1];
    }
  }
  return answer;
}

/** Get a friendly label for common option values */
function getOptionDisplayLabel(option: UIQuestionOption): string {
  const lower = option.value.toLowerCase();
  if (option.isYes) return 'Yes';
  if (option.isNo) return 'No';
  if (lower === 'a' || lower === 'all') return 'All';
  if (lower === 'q' || lower === 'quit') return 'Quit';
  return option.label;
}

/** Determine button variant based on option semantics */
function getOptionVariant(option: UIQuestionOption): 'primary' | 'danger' | 'warning' | 'default' {
  if (option.isYes || option.isRecommended) return 'primary';
  if (option.isNo) return 'danger';
  const lower = option.value.toLowerCase();
  if (lower === 'q' || lower === 'quit') return 'warning';
  return 'default';
}

/** Large tap-friendly button for option selection */
function OptionButton({
  label,
  variant = 'default',
  onClick,
  disabled,
}: {
  readonly label: string;
  readonly variant?: 'primary' | 'danger' | 'warning' | 'default';
  readonly onClick: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        'flex min-h-[44px] min-w-[44px] items-center justify-center',
        'rounded-xl px-6 py-3 text-sm font-semibold',
        'transition-all duration-150 active:scale-[0.97]',
        'shadow-sm border',
        disabled && 'pointer-events-none opacity-40',
        variant === 'primary' && [
          'bg-[--color-primary] text-white border-[--color-primary]',
          'hover:bg-[--color-primary-dark]',
        ],
        variant === 'danger' && [
          'bg-[--color-error]/10 text-[--color-error] border-[--color-error]/20',
          'hover:bg-[--color-error]/20',
        ],
        variant === 'warning' && [
          'bg-[--color-warning]/10 text-[--color-warning] border-[--color-warning]/20',
          'hover:bg-[--color-warning]/20',
        ],
        variant === 'default' && [
          'bg-[--color-surface-elevated] text-[--color-text] border-[--color-border]',
          'hover:bg-[--color-surface-light]',
        ],
      )}
    >
      {label}
    </button>
  );
}

/** Yes/No card with two large buttons */
function YesNoCard({
  question,
  onAnswer,
}: {
  readonly question: UIQuestion;
  readonly onAnswer: (answer: string) => void;
}) {
  const yesOption = question.structuredOptions?.find((o) => o.isYes);
  const noOption = question.structuredOptions?.find((o) => o.isNo);

  return (
    <div className="flex gap-3">
      <OptionButton
        label="Yes"
        variant="primary"
        onClick={() => onAnswer(yesOption?.value ?? 'yes')}
      />
      <OptionButton label="No" variant="danger" onClick={() => onAnswer(noOption?.value ?? 'no')} />
    </div>
  );
}

/** Multi-option card (yes/no + extra options like all/quit) */
function MultiOptionCard({
  question,
  onAnswer,
}: {
  readonly question: UIQuestion;
  readonly onAnswer: (answer: string) => void;
}) {
  const options = question.structuredOptions ?? [];

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <OptionButton
          key={option.value}
          label={getOptionDisplayLabel(option)}
          variant={getOptionVariant(option)}
          onClick={() => onAnswer(option.value)}
        />
      ))}
    </div>
  );
}

/** Numbered selection card with tap targets */
function NumberedCard({
  question,
  onAnswer,
}: {
  readonly question: UIQuestion;
  readonly onAnswer: (answer: string) => void;
}) {
  const options = question.options ?? [];

  return (
    <div className="flex flex-col gap-1.5">
      {options.map((option, index) => (
        <button
          type="button"
          key={`opt-${index + 1}-${option}`}
          onClick={() => onAnswer(String(index + 1))}
          className={clsx(
            'flex min-h-[44px] items-center gap-3 rounded-xl px-4 py-3',
            'bg-[--color-surface-elevated] border border-[--color-border]',
            'text-left text-sm text-[--color-text]',
            'transition-all duration-150 active:scale-[0.98]',
            'hover:bg-[--color-surface-light] hover:border-[--color-primary]/30',
          )}
        >
          <span
            className={clsx(
              'flex size-7 shrink-0 items-center justify-center rounded-full',
              'bg-[--color-primary]/10 text-xs font-bold text-[--color-primary]',
            )}
          >
            {index + 1}
          </span>
          <span className="flex-1">{option}</span>
          <ChevronRight className="size-4 shrink-0 text-[--color-text-muted]" />
        </button>
      ))}
    </div>
  );
}

/** Free text input card */
function FreeTextCard({
  onAnswer,
}: {
  readonly onAnswer: (answer: string) => void;
}) {
  const [value, setValue] = useState('');

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onAnswer(trimmed);
    setValue('');
  }, [value, onAnswer]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type your response..."
        className={clsx(
          'min-h-[44px] flex-1 rounded-xl border border-[--color-border]',
          'bg-[--color-surface-elevated] px-4 py-2.5 text-sm text-[--color-text]',
          'placeholder:text-[--color-text-muted]',
          'outline-none focus:ring-2 focus:ring-[--color-primary]/50',
        )}
      />
      <button
        type="button"
        onClick={handleSubmit}
        disabled={!value.trim()}
        className={clsx(
          'flex size-[44px] items-center justify-center rounded-xl',
          'transition-all duration-150 active:scale-95',
          value.trim()
            ? 'bg-[--color-primary] text-white hover:bg-[--color-primary-dark]'
            : 'bg-[--color-surface-elevated] text-[--color-text-muted]',
        )}
        aria-label="Send response"
      >
        <Send className="size-5" />
      </button>
    </div>
  );
}

/** Answered state: collapsed card showing the selected answer */
function AnsweredCard({
  question,
}: {
  readonly question: UIQuestion;
}) {
  const answerLabel = resolveAnswerLabel(question, question.answeredWith ?? '');

  return (
    <div
      className={clsx(
        'flex items-center gap-2 rounded-xl px-4 py-2.5',
        'bg-[--color-success]/10 border border-[--color-success]/20',
        'text-sm text-[--color-text-secondary]',
        'animate-[fade-in_200ms_ease-out]',
      )}
    >
      <Check className="size-4 shrink-0 text-[--color-success]" />
      <span>
        Answered: <span className="font-medium text-[--color-text]">{answerLabel}</span>
      </span>
    </div>
  );
}

export function QuestionCard({ question, onAnswer, className }: QuestionCardProps) {
  const isAnswered = question.answeredWith != null;

  return (
    <div
      className={clsx(
        'rounded-2xl border border-[--color-border] bg-[--color-surface]',
        'shadow-md p-4',
        'animate-[slide-up_200ms_ease-out]',
        isAnswered && 'opacity-75',
        className,
      )}
    >
      {/* Question prompt */}
      <div className="mb-3 flex items-start gap-2">
        <MessageSquare className="mt-0.5 size-4 shrink-0 text-[--color-primary]" />
        <p className="text-sm font-medium text-[--color-text]">{question.prompt}</p>
      </div>

      {/* Answer area */}
      {isAnswered ? (
        <AnsweredCard question={question} />
      ) : question.type === 'yes_no' ? (
        <YesNoCard question={question} onAnswer={onAnswer} />
      ) : question.type === 'multi_option' ? (
        <MultiOptionCard question={question} onAnswer={onAnswer} />
      ) : question.type === 'numbered' ? (
        <NumberedCard question={question} onAnswer={onAnswer} />
      ) : (
        <FreeTextCard onAnswer={onAnswer} />
      )}
    </div>
  );
}
