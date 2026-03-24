/**
 * ChatMessage component.
 *
 * Renders parsed message content with code blocks, inline formatting,
 * lists, and tool use cards. Used within MessageBubble for enhanced
 * chat mode rendering.
 */

import type { ContentSegment } from "@/lib/parse-content";
import { parseContent } from "@/lib/parse-content";
import { clsx } from "clsx";
import { Copy, Check } from "lucide-react";
import { useMemo, useState, useCallback } from "react";
import { ToolUseCard } from "./ToolUseCard";

interface ChatMessageProps {
  readonly content: string;
  readonly toolName?: string;
  readonly isUser?: boolean;
}

/** Render a single content segment */
function SegmentRenderer({
  segment,
  isUser,
}: { readonly segment: ContentSegment; readonly isUser: boolean }) {
  switch (segment.type) {
    case "text":
      return (
        <span className="whitespace-pre-wrap break-words">{segment.text}</span>
      );

    case "code_block":
      return <CodeBlock language={segment.language} code={segment.code} />;

    case "inline_code":
      return (
        <code
          className={clsx(
            "rounded px-1.5 py-0.5 text-[0.85em]",
            "font-[family-name:--font-mono]",
            isUser
              ? "bg-white/15"
              : "bg-[var(--color-surface-light)] text-[var(--color-primary)]",
          )}
        >
          {segment.code}
        </code>
      );

    case "bold":
      return <strong className="font-semibold">{segment.text}</strong>;

    case "italic":
      return <em className="italic">{segment.text}</em>;

    case "list_item":
      return (
        <div className="flex gap-2 pl-1">
          <span className="shrink-0 text-[var(--color-text-muted)]">
            {segment.ordered ? `${segment.index}.` : "-"}
          </span>
          <span className="break-words">{segment.text}</span>
        </div>
      );
  }
}

/** Fenced code block with copy button */
function CodeBlock({
  language,
  code,
}: { readonly language: string; readonly code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="my-2 rounded-lg border border-[var(--color-border)] overflow-hidden bg-[var(--color-surface)]">
      {/* Header with language label and copy button */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-light)] px-3 py-1.5">
        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
          {language || "code"}
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
      {/* Code content */}
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed font-[family-name:--font-mono] text-[var(--color-text)]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function ChatMessage({ content, toolName, isUser = false }: ChatMessageProps) {
  const segments = useMemo(() => parseContent(content), [content]);

  // If this is a tool use message, wrap in a ToolUseCard
  if (toolName) {
    return <ToolUseCard toolName={toolName} content={content} />;
  }

  return (
    <div className="text-sm leading-relaxed">
      {segments.map((segment, i) => (
        <SegmentRenderer key={`${segment.type}-${i}`} segment={segment} isUser={isUser} />
      ))}
    </div>
  );
}
