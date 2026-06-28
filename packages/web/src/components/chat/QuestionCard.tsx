/**
 * QuestionCard component.
 *
 * The headline interaction of the chat screen: a pinned permission / question
 * card. For a plain permission it renders large tap-friendly option rows. For a
 * structured AskUserQuestion (#627) it renders an interactive multi-question form
 * — radio per single-select, checkbox per multi-select, with the authored option
 * descriptions — and a single Submit. Every card also exposes a Cancel/Esc
 * control: the universal unstick that tells the daemon to Esc the prompt so the
 * user is never stuck on something the app can't drive.
 */

import { formatRelativeTime } from '@/lib/format-time';
import type {
  UIQuestion,
  UIQuestionOption,
  UIQuestionResolvedReason,
  UIQuestionStep,
} from '@/types';
import { clsx } from 'clsx';
import { Check, Send, X } from 'lucide-react';
import { type KeyboardEvent, useCallback, useMemo, useState } from 'react';

/** One sub-question's chosen option indices (0-based), the shape sent to the
 *  daemon as a structured AskUserQuestion answer (#627). */
export interface AuqSelection {
  readonly questionIndex: number;
  readonly optionIndices: number[];
}

interface QuestionCardProps {
  readonly question: UIQuestion;
  readonly onAnswer: (answer: string) => void;
  /** #627: submit a structured AskUserQuestion answer (the daemon drives the TUI). */
  readonly onAuqAnswer?: (selections: AuqSelection[]) => void;
  /** #627: cancel/escape the prompt (the daemon sends Esc). The never-stuck floor. */
  readonly onCancel?: () => void;
  readonly className?: string;
}

/** Resolve the display label for an answered value. */
/** Human label for a prompt resolved on another channel (#652). */
function resolveTraceLabel(reason: UIQuestionResolvedReason): string {
  switch (reason) {
    case 'answered':
      return 'Answered on another device';
    case 'auto_approved':
      return 'Auto-approved';
    case 'auto_denied':
      return 'Auto-denied';
    case 'cancelled':
      return 'Cancelled';
  }
}

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
  /** Authored per-option explanation (AskUserQuestion `description`, #626). */
  readonly description?: string;
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

/** Flatten a permission question into a uniform option list for rendering. */
function buildOptions(question: UIQuestion): RenderOption[] {
  if (question.structuredOptions && question.structuredOptions.length > 0) {
    return question.structuredOptions.map((o) => ({
      key: o.value,
      badge: o.value.slice(0, 2).toUpperCase(),
      label: o.label,
      hint: optionHint(o),
      kind: optionKind(o),
      ...(o.description ? { description: o.description } : {}),
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

/** A single permission option row. */
function OptionRow({
  option,
  onAnswer,
}: { readonly option: RenderOption; readonly onAnswer: (v: string) => void }) {
  const { kind, description } = option;
  return (
    <button
      type="button"
      onClick={() => onAnswer(option.key)}
      className={clsx(
        'flex min-h-[44px] gap-2.5 rounded-[10px] px-3 py-2.5 text-left transition-transform active:scale-[0.99]',
        description ? 'items-start' : 'items-center',
      )}
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
        className={clsx(
          'inline-flex size-[22px] shrink-0 items-center justify-center rounded-md font-mono text-[11px] font-bold',
          description && 'mt-0.5',
        )}
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
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="text-sm font-semibold">{option.label}</span>
          {option.hint && <span className="ml-auto text-[11px] opacity-70">{option.hint}</span>}
        </span>
        {description && (
          <span className="break-anywhere mt-0.5 text-[12px] leading-snug opacity-75">
            {description}
          </span>
        )}
      </span>
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

/** One selectable option in the multi-question form (#627). */
function FormOption({
  step,
  index,
  selected,
  disabled,
  onToggle,
}: {
  readonly step: UIQuestionStep;
  readonly index: number;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}) {
  const opt = step.options[index];
  if (!opt) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className="flex min-h-[44px] items-start gap-2.5 rounded-[10px] px-3 py-2.5 text-left transition-transform active:scale-[0.99] disabled:opacity-60"
      style={{
        background: selected ? 'var(--color-primary)' : 'var(--color-surface-elevated)',
        color: selected ? 'var(--color-accent-ink)' : 'var(--color-text)',
      }}
    >
      <span
        className={clsx(
          'mt-0.5 inline-flex size-[20px] shrink-0 items-center justify-center border',
          step.multiSelect ? 'rounded-[5px]' : 'rounded-full',
        )}
        style={{
          borderColor: selected ? 'var(--color-accent-ink)' : 'var(--color-border)',
          background: selected ? 'var(--color-accent-ink-14)' : 'transparent',
        }}
      >
        {selected && <Check className="size-3.5" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold">{opt.label}</span>
        {opt.description && (
          <span className="break-anywhere mt-0.5 text-[12px] leading-snug opacity-75">
            {opt.description}
          </span>
        )}
      </span>
    </button>
  );
}

/** The interactive AskUserQuestion form (#627): one group per sub-question, a
 *  single Submit, and the never-stuck Cancel. */
function MultiQuestionForm({
  question,
  steps,
  onAuqAnswer,
  onCancel,
}: {
  readonly question: UIQuestion;
  readonly steps: readonly UIQuestionStep[];
  readonly onAuqAnswer?: (selections: AuqSelection[]) => void;
  readonly onCancel?: () => void;
}) {
  const [selected, setSelected] = useState<Map<number, Set<number>>>(new Map());
  const submitting = question.submitting ?? false;
  const failed = question.autoAnswerFailed ?? false;

  const toggle = useCallback((qi: number, oi: number, multi: boolean) => {
    setSelected((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(qi) ?? []);
      if (multi) {
        if (set.has(oi)) set.delete(oi);
        else set.add(oi);
      } else {
        set.clear();
        set.add(oi);
      }
      next.set(qi, set);
      return next;
    });
  }, []);

  const allAnswered = useMemo(
    () => steps.every((_, qi) => (selected.get(qi)?.size ?? 0) > 0),
    [steps, selected],
  );

  const submit = useCallback(() => {
    if (!onAuqAnswer) return;
    const selections: AuqSelection[] = steps.map((_, qi) => ({
      questionIndex: qi,
      optionIndices: [...(selected.get(qi) ?? [])].sort((a, b) => a - b),
    }));
    onAuqAnswer(selections);
  }, [onAuqAnswer, steps, selected]);

  return (
    <div className="flex flex-col gap-3 px-3 pb-3 pt-1">
      {steps.map((step, qi) => (
        <div key={`${step.header ?? ''}-${step.text.slice(0, 24)}-${qi}`} className="flex flex-col gap-1.5">
          <div className="px-1">
            {step.header && (
              <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-[var(--color-accent-text)]">
                {step.header}
              </span>
            )}
            <p className="break-anywhere text-[14px] font-medium leading-snug text-[var(--color-text)]">
              {step.text}
            </p>
            {step.multiSelect && (
              <p className="text-[11px] text-[var(--color-text-secondary)]">Select all that apply</p>
            )}
          </div>
          {step.options.map((opt, oi) => (
            <FormOption
              key={opt.value || opt.label}
              step={step}
              index={oi}
              selected={selected.get(qi)?.has(oi) ?? false}
              disabled={submitting || failed}
              onToggle={() => toggle(qi, oi, step.multiSelect)}
            />
          ))}
        </div>
      ))}

      {failed && (
        <p
          className="rounded-[10px] px-3 py-2 text-[12px]"
          style={{ background: 'var(--color-surface-elevated)', color: 'var(--color-text)' }}
        >
          Couldn't auto-answer this on your device. Cancel it, or answer it in the terminal.
        </p>
      )}

      {/* #654: once auto-answer has failed, re-submitting the structured form
          re-drives an already-navigated TUI and only corrupts it further, so the
          Submit button is withdrawn — Cancel (Esc) or the terminal are the safe
          ways forward. Before failure, Submit + Cancel render as usual. */}
      <div className="flex items-center gap-2 pt-0.5">
        {!failed && (
          <button
            type="button"
            onClick={submit}
            disabled={!allAnswered || submitting}
            className="flex min-h-[44px] flex-1 items-center justify-center rounded-[10px] text-sm font-semibold transition-transform active:scale-[0.99] disabled:opacity-50"
            style={{ background: 'var(--color-primary)', color: 'var(--color-accent-ink)' }}
          >
            {submitting ? 'Answering…' : (question.submitLabel ?? 'Submit')}
          </button>
        )}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className={clsx(
              'flex min-h-[44px] items-center justify-center rounded-[10px] px-4 text-sm font-semibold transition-transform active:scale-[0.99]',
              failed && 'flex-1',
            )}
            style={
              failed
                ? { background: 'var(--color-primary)', color: 'var(--color-accent-ink)' }
                : { background: 'transparent', color: 'var(--color-text)', border: '1px solid var(--color-border)' }
            }
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export function QuestionCard({ question, onAnswer, onAuqAnswer, onCancel, className }: QuestionCardProps) {
  const isAnswered = question.answeredWith != null;
  const options = buildOptions(question);
  const isPermission = options.some((o) => o.kind === 'primary' || o.kind === 'danger');
  // #627: a structured AskUserQuestion renders the interactive multi-question form.
  const steps = question.kind === 'multi_question' ? question.questions : undefined;
  const isForm = !!steps && steps.length > 0;
  const headerLabel = isForm
    ? `Question${steps.length > 1 ? `s · ${steps.length}` : ''}`
    : isPermission
      ? 'Permission request'
      : 'Question';

  const resolvedReason = question.resolvedReason;
  if (isAnswered || resolvedReason != null) {
    // Positive resolutions (answered locally, answered elsewhere, auto-approved)
    // read as a green confirmation; auto-denied / cancelled use a neutral bar so
    // the trace doesn't masquerade as an approval (#652).
    const positive =
      isAnswered || resolvedReason === 'answered' || resolvedReason === 'auto_approved';
    return (
      <div
        className={clsx(
          'mx-3.5 my-2 flex items-center gap-2 rounded-2xl border px-4 py-2.5 text-sm',
          'animate-[fade-in_200ms_ease-out]',
          className,
        )}
        style={
          positive
            ? {
                background: 'var(--color-success-soft)',
                borderColor: 'var(--color-success-line)',
                color: 'var(--color-text-secondary)',
              }
            : {
                background: 'var(--color-surface-light)',
                borderColor: 'var(--color-border)',
                color: 'var(--color-text-secondary)',
              }
        }
      >
        {positive ? (
          <Check className="size-4 shrink-0 text-[var(--color-success)]" />
        ) : (
          <X className="size-4 shrink-0 text-[var(--color-text-muted)]" />
        )}
        {isAnswered ? (
          <span>
            Answered:{' '}
            <span className="font-medium text-[var(--color-text)]">
              {resolveAnswerLabel(question, question.answeredWith ?? '')}
            </span>
          </span>
        ) : (
          <span className="font-medium text-[var(--color-text)]">
            {resolvedReason ? resolveTraceLabel(resolvedReason) : ''}
          </span>
        )}
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
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-[var(--color-accent-text)]">
          {headerLabel}
        </span>
        <span className="ml-auto font-mono text-[11px] text-[var(--color-text-secondary)]">
          {formatRelativeTime(question.timestamp)}
        </span>
        {/* #627: the universal escape — present on every card so the user is never
            stuck on a prompt the app can't drive. */}
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel (Esc)"
            title="Cancel (Esc)"
            className="flex size-[26px] items-center justify-center rounded-md text-[var(--color-text-secondary)] transition-transform active:scale-90"
          >
            <X className="size-4" />
          </button>
        )}
      </div>

      {isForm ? (
        <MultiQuestionForm
          question={question}
          steps={steps}
          {...(onAuqAnswer ? { onAuqAnswer } : {})}
          {...(onCancel ? { onCancel } : {})}
        />
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
