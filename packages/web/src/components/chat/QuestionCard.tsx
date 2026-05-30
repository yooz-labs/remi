/**
 * QuestionCard component.
 *
 * The headline interaction of the chat screen: a pinned permission / question
 * card. Renders a labeled header (with elapsed time), the prompt, and large
 * tap-friendly option rows with key badges and hints (Allow once / Remember
 * for session / Cancel). Free-text questions get an inline input.
 */

import { formatRelativeTime } from '@/lib/format-time';
import type { UIQuestion, UIQuestionOption } from '@/types';
import { clsx } from 'clsx';
import { Check, Send } from 'lucide-react';
import { type KeyboardEvent, useCallback, useState } from 'react';

interface QuestionCardProps {
  readonly question: UIQuestion;
  readonly onAnswer: (answer: string) => void;
  readonly className?: string;
}

/** Resolve the display label for an answered value. */
function resolveAnswerLabel(question: UIQuestion, answer: string): string {
  if (question.structuredOptions) {
    const match = question.structuredOptions.find((o) => o.value === answer);
    if (match) return match.label;
  }
  if (question.options) {
    const idx = Number.parseInt(answer, 10);
    if (!Number.isNaN(idx) && idx >= 1 && idx <= question.options.length) {
      return question.options[idx - 1];
    }
  }
  return answer;
}

type OptionKind = 'primary' | 'danger' | 'default';

interface RenderOption {
  readonly key: string;
  readonly badge: string;
  readonly label: string;
  readonly hint?: string;
  readonly kind: OptionKind;
}

/** Hint text shown to the right of permission-style options. */
function optionHint(option: UIQuestionOption): string | undefined {
  if (/always/i.test(option.label)) return 'Remember for session';
  if (option.isYes) return 'Allow once';
  if (option.isNo) return 'Cancel';
  return undefined;
}

function optionKind(option: UIQuestionOption): OptionKind {
  if (option.isYes || option.isRecommended) return 'primary';
  if (option.isNo) return 'danger';
  return 'default';
}

/** Flatten any question shape into a uniform option list for rendering. */
function buildOptions(question: UIQuestion): RenderOption[] {
  if (question.structuredOptions && question.structuredOptions.length > 0) {
    return question.structuredOptions.map((o) => ({
      key: o.value,
      badge: o.value.slice(0, 2).toUpperCase(),
      label: o.label,
      hint: optionHint(o),
      kind: optionKind(o),
    }));
  }
  if (question.type === 'yes_no') {
    return [
      { key: 'y', badge: 'Y', label: 'Yes', hint: 'Allow once', kind: 'primary' },
      { key: 'n', badge: 'N', label: 'No', hint: 'Cancel', kind: 'danger' },
    ];
  }
  if (question.options && question.options.length > 0) {
    return question.options.map((label, i) => ({
      key: String(i + 1),
      badge: String(i + 1),
      label,
      kind: 'default' as const,
    }));
  }
  return [];
}

/** A single option row. */
function OptionRow({ option, onAnswer }: { readonly option: RenderOption; readonly onAnswer: (v: string) => void }) {
  const { kind } = option;
  return (
    <button
      type="button"
      onClick={() => onAnswer(option.key)}
      className="flex min-h-[44px] items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left transition-transform active:scale-[0.99]"
      style={{
        background:
          kind === 'primary'
            ? 'var(--color-primary)'
            : kind === 'danger'
              ? 'transparent'
              : 'var(--color-surface-elevated)',
        color: kind === 'primary' ? 'var(--color-accent-ink)' : 'var(--color-text)',
        border: kind === 'danger' ? '1px solid var(--color-border)' : 'none',
      }}
    >
      <span
        className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-bold"
        style={{
          background:
            kind === 'primary'
              ? 'var(--color-accent-ink-14)'
              : kind === 'danger'
                ? 'var(--color-surface-elevated)'
                : 'var(--color-surface)',
          opacity: 0.95,
        }}
      >
        {option.badge}
      </span>
      <span className="text-sm font-semibold">{option.label}</span>
      {option.hint && (
        <span className="ml-auto text-[11px] opacity-70">{option.hint}</span>
      )}
    </button>
  );
}

/** Free text input row. */
function FreeTextRow({ onAnswer }: { readonly onAnswer: (v: string) => void }) {
  const [value, setValue] = useState('');
  const submit = useCallback(() => {
    const t = value.trim();
    if (!t) return;
    onAnswer(t);
    setValue('');
  }, [value, onAnswer]);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKey}
        placeholder="Type your response..."
        className="min-h-[44px] flex-1 rounded-[10px] border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:ring-2 focus:ring-[var(--color-primary)]/40"
      />
      <button
        type="button"
        onClick={submit}
        disabled={!value.trim()}
        className="flex size-[44px] items-center justify-center rounded-[10px] transition-transform active:scale-95"
        style={{
          background: value.trim() ? 'var(--color-primary)' : 'var(--color-surface-elevated)',
          color: value.trim() ? 'var(--color-accent-ink)' : 'var(--color-text-muted)',
        }}
        aria-label="Send response"
      >
        <Send className="size-5" />
      </button>
    </div>
  );
}

export function QuestionCard({ question, onAnswer, className }: QuestionCardProps) {
  const isAnswered = question.answeredWith != null;
  const options = buildOptions(question);
  const isPermission = options.some((o) => o.kind === 'primary' || o.kind === 'danger');
  const headerLabel = isPermission ? 'Permission request' : 'Question';

  if (isAnswered) {
    return (
      <div
        className={clsx(
          'mx-3.5 my-2 flex items-center gap-2 rounded-2xl border px-4 py-2.5 text-sm',
          'animate-[fade-in_200ms_ease-out]',
          className,
        )}
        style={{
          background: 'var(--color-success-soft)',
          borderColor: 'var(--color-success-line)',
          color: 'var(--color-text-secondary)',
        }}
      >
        <Check className="size-4 shrink-0 text-[var(--color-success)]" />
        <span>
          Answered:{' '}
          <span className="font-medium text-[var(--color-text)]">
            {resolveAnswerLabel(question, question.answeredWith ?? '')}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div
      className={clsx('mx-3.5 my-2 overflow-hidden rounded-[18px]', className)}
      style={{
        background: 'var(--color-surface-light)',
        border: '1px solid var(--color-accent-33)',
        boxShadow: '0 0 0 4px var(--color-accent-7), 0 12px 32px -16px var(--color-accent-33)',
        animation: 'slide-up 200ms ease-out',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3.5 py-2.5"
        style={{
          background: 'var(--color-accent-soft)',
          borderBottom: '1px solid var(--color-accent-13)',
        }}
      >
        <span
          className="size-1.5 rounded-full bg-[var(--color-primary)]"
          style={{ color: 'var(--color-primary)', animation: 'pulse-dot 1.4s ease-out infinite' }}
        />
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-[var(--color-primary)]">
          {headerLabel}
        </span>
        <span className="ml-auto font-mono text-[11px] text-[var(--color-text-secondary)]">
          {formatRelativeTime(question.timestamp)}
        </span>
      </div>

      {/* Prompt */}
      <div className="px-4 pb-1.5 pt-3.5">
        <p className="break-anywhere text-[15px] font-medium leading-snug text-[var(--color-text)]">
          {question.prompt}
        </p>
      </div>

      {/* Options / free text */}
      <div className="flex flex-col gap-1.5 px-3 pb-3 pt-2.5">
        {options.length > 0 ? (
          options.map((o) => <OptionRow key={o.key} option={o} onAnswer={onAnswer} />)
        ) : (
          <FreeTextRow onAnswer={onAnswer} />
        )}
      </div>
    </div>
  );
}
