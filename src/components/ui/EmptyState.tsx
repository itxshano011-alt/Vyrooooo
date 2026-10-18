"use client";

import type { ReactNode } from "react";
import { Button } from "./Button";

/**
 * Props: title, description?, actionLabel?, onAction?, icon?.
 * Used for empty feeds, lists, and search results.
 */
export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      {icon && <div className="text-ink-muted">{icon}</div>}
      <h3 className="text-lg font-bold text-ink">{title}</h3>
      {description && <p className="max-w-sm text-sm text-ink-muted">{description}</p>}
      {actionLabel && onAction && (
        <Button variant="secondary" onClick={onAction} className="mt-2">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
