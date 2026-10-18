"use client";

import { forwardRef, type TextareaHTMLAttributes } from "react";

/** Multiline input. Props: standard textarea attrs + error (red border). */
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ error = false, className = "", ...rest }, ref) => (
    <textarea
      ref={ref}
      className={`w-full rounded-xl border bg-surface-elevated px-4 py-2.5 text-ink placeholder:text-ink-muted focus:border-[var(--color-brand-blue)] focus:outline-none disabled:opacity-50 ${
        error ? "border-red-500" : "border-border"
      } ${className}`}
      aria-invalid={error || undefined}
      {...rest}
    />
  )
);
Textarea.displayName = "Textarea";
