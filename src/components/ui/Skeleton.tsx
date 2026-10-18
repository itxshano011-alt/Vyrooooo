"use client";

/** Shimmer placeholder. Props: className (size/shape), label. Respects reduced motion via global CSS. */
export function Skeleton({ className = "", label = "Loading" }: { className?: string; label?: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className={`animate-pulse rounded-xl bg-surface-elevated ${className}`}
    />
  );
}
