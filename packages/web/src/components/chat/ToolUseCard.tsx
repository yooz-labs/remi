/**
 * ToolUseCard component.
 *
 * Collapsible card for tool use messages (Read, Write, Edit, Bash, etc.).
 * Shows tool name and a summary when collapsed; full details when expanded.
 */

import { clsx } from "clsx";
import {
  ChevronDown,
  ChevronRight,
  FileCode,
  FileEdit,
  FilePlus,
  Search,
  Terminal,
  Type,
} from "lucide-react";
import { useState } from "react";

interface ToolUseCardProps {
  readonly toolName: string;
  readonly content: string;
  readonly defaultExpanded?: boolean;
}

/** Icon for a given tool name */
function ToolIcon({
  name,
  className,
}: { readonly name: string; readonly className?: string }) {
  const lower = name.toLowerCase();
  if (lower.includes("bash") || lower.includes("terminal"))
    return <Terminal className={className} />;
  if (lower.includes("read")) return <FileCode className={className} />;
  if (lower.includes("edit")) return <FileEdit className={className} />;
  if (lower.includes("write")) return <FilePlus className={className} />;
  if (lower.includes("grep") || lower.includes("search") || lower.includes("glob"))
    return <Search className={className} />;
  return <Type className={className} />;
}

/** Extract a short summary from tool content */
function summarize(_toolName: string, content: string): string {
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  if (firstLine.length <= 80) return firstLine;
  return `${firstLine.slice(0, 77)}...`;
}

export function ToolUseCard({
  toolName,
  content,
  defaultExpanded = false,
}: ToolUseCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const summary = summarize(toolName, content);

  return (
    <div
      className={clsx(
        "rounded-lg border border-[var(--color-border)] overflow-hidden",
        "bg-[var(--color-surface-light)] transition-colors",
      )}
    >
      {/* Header (always visible) */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={clsx(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          "hover:bg-[var(--color-surface-elevated)] transition-colors",
        )}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-[var(--color-text-muted)]" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-[var(--color-text-muted)]" />
        )}
        <ToolIcon
          name={toolName}
          className="size-3.5 shrink-0 text-[var(--color-primary)]"
        />
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">
          {toolName}
        </span>
        {!expanded && summary && (
          <span className="truncate text-xs text-[var(--color-text-muted)]">
            {summary}
          </span>
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-[var(--color-border)] px-3 py-2">
          <pre
            className={clsx(
              "whitespace-pre-wrap break-words text-xs leading-relaxed",
              "text-[var(--color-text)] font-[family-name:--font-mono]",
              "max-h-64 overflow-y-auto",
            )}
          >
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}
