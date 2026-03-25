/**
 * ChatMessage component.
 *
 * Renders message content as markdown for both user and assistant
 * messages. User messages use alternate styling (translucent code
 * backgrounds). Tool messages delegate to ToolUseCard.
 */

import { clsx } from 'clsx';
import { Check, Copy } from 'lucide-react';
import { useCallback, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ToolUseCard } from './ToolUseCard';

interface ChatMessageProps {
  readonly content: string;
  readonly toolName?: string;
  readonly isUser?: boolean;
}

/** Fenced code block with copy button */
function CodeBlock({
  language,
  code,
}: { readonly language: string; readonly code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch((err) => {
      console.warn('Failed to copy to clipboard:', err);
    });
  }, [code]);

  return (
    <div className="my-2 rounded-lg border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-light)] px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="size-3" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="size-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed font-[family-name:--font-mono] text-[var(--color-text)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Markdown renderer components for react-markdown */
const markdownComponents = {
  h1: ({ children, ...props }: React.ComponentProps<'h1'>) => (
    <h1 className="text-lg font-bold mb-2 mt-3 text-[var(--color-text)]" {...props}>{children}</h1>
  ),
  h2: ({ children, ...props }: React.ComponentProps<'h2'>) => (
    <h2 className="text-base font-bold mb-1.5 mt-2.5 text-[var(--color-text)]" {...props}>{children}</h2>
  ),
  h3: ({ children, ...props }: React.ComponentProps<'h3'>) => (
    <h3 className="text-sm font-bold mb-1 mt-2 text-[var(--color-text)]" {...props}>{children}</h3>
  ),
  p: ({ children, ...props }: React.ComponentProps<'p'>) => (
    <p className="mb-2 last:mb-0" {...props}>{children}</p>
  ),
  ul: ({ children, ...props }: React.ComponentProps<'ul'>) => (
    <ul className="mb-2 ml-4 list-disc space-y-0.5" {...props}>{children}</ul>
  ),
  ol: ({ children, ...props }: React.ComponentProps<'ol'>) => (
    <ol className="mb-2 ml-4 list-decimal space-y-0.5" {...props}>{children}</ol>
  ),
  li: ({ children, ...props }: React.ComponentProps<'li'>) => (
    <li className="text-sm leading-relaxed" {...props}>{children}</li>
  ),
  strong: ({ children, ...props }: React.ComponentProps<'strong'>) => (
    <strong className="font-semibold" {...props}>{children}</strong>
  ),
  em: ({ children, ...props }: React.ComponentProps<'em'>) => (
    <em className="italic" {...props}>{children}</em>
  ),
  a: ({ children, href, ...props }: React.ComponentProps<'a'>) => (
    <a
      href={href}
      className="text-[var(--color-primary)] underline underline-offset-2"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  blockquote: ({ children, ...props }: React.ComponentProps<'blockquote'>) => (
    <blockquote
      className="border-l-2 border-[var(--color-primary)] pl-3 my-2 text-[var(--color-text-secondary)] italic"
      {...props}
    >
      {children}
    </blockquote>
  ),
  hr: (props: React.ComponentProps<'hr'>) => (
    <hr className="my-3 border-[var(--color-border)]" {...props} />
  ),
  table: ({ children, ...props }: React.ComponentProps<'table'>) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full text-xs border-collapse" {...props}>{children}</table>
    </div>
  ),
  th: ({ children, ...props }: React.ComponentProps<'th'>) => (
    <th className="border border-[var(--color-border)] bg-[var(--color-surface-light)] px-2 py-1 text-left font-semibold" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.ComponentProps<'td'>) => (
    <td className="border border-[var(--color-border)] px-2 py-1" {...props}>{children}</td>
  ),
  code: ({ children, className, ...props }: React.ComponentProps<'code'> & { inline?: boolean }) => {
    const match = /language-(\w+)/.exec(className || '');
    const isBlock = !!(className && match);

    if (isBlock) {
      return (
        <CodeBlock language={match?.[1] || ''} code={String(children).replace(/\n$/, '')} />
      );
    }

    return (
      <code
        className={clsx(
          'rounded px-1.5 py-0.5 text-[0.85em]',
          'font-[family-name:--font-mono]',
          'bg-[var(--color-surface-light)] text-[var(--color-primary)]',
        )}
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }: React.ComponentProps<'pre'>) => {
    // react-markdown wraps code blocks in <pre><code>, but our code component
    // handles the full rendering including the wrapper, so just pass through
    return <>{children}</>;
  },
};

/** User-message-specific overrides (white text on teal) */
const userMarkdownComponents = {
  ...markdownComponents,
  code: ({ children, className, ...props }: React.ComponentProps<'code'>) => {
    const match = /language-(\w+)/.exec(className || '');
    if (className && match) {
      return <CodeBlock language={match[1] || ''} code={String(children).replace(/\n$/, '')} />;
    }
    return (
      <code className="rounded px-1.5 py-0.5 text-[0.85em] font-[family-name:--font-mono] bg-white/15" {...props}>
        {children}
      </code>
    );
  },
  a: ({ children, href, ...props }: React.ComponentProps<'a'>) => (
    <a href={href} className="underline underline-offset-2" target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
};

export function ChatMessage({ content, toolName, isUser = false }: ChatMessageProps) {
  if (toolName) {
    return <ToolUseCard toolName={toolName} content={content} />;
  }

  return (
    <div className="text-sm leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={isUser ? userMarkdownComponents : markdownComponents}
      >
        {content}
      </Markdown>
    </div>
  );
}
