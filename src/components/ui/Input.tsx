"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

/** Text input styled for both themes. Props: standard input attrs + error (red border). */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ error = false, className = "", ...rest }, ref) => (
    <input
      ref={ref}
      className={`w-full rounded-xl border bg-surface-elevated px-4 py-2.5 text-ink placeholder:text-ink-muted focus:border-[var(--color-brand-blue)] focus:outline-none disabled:opacity-50 ${
        error ? "border-red-500" : "border-border"
      } ${className}`}
      aria-invalid={error || undefined}
      {...rest}
    />
  )
);
Input.displayName = "Input";
