"use client";

import { useState } from "react";

/**
 * Props: src (image URL or null), name (fallback initials), size (sm | md | lg | xl).
 * Renders the image; falls back to initials on missing src or load error.
 */
export function Avatar({
  src,
  name,
  size = "md",
}: {
  src?: string | null;
  name?: string | null;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const [failed, setFailed] = useState(false);

  const dims =
    size === "sm"
      ? "h-8 w-8 text-xs"
      : size === "lg"
        ? "h-16 w-16 text-xl"
        : size === "xl"
          ? "h-24 w-24 text-3xl"
          : "h-10 w-10 text-sm";

  const initials = (name ?? "?")
    .split(/[\s_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-[linear-gradient(135deg,var(--color-brand-blue),var(--color-brand-violet))] font-bold text-white ${dims}`}
      aria-hidden={src && !failed ? true : undefined}
      role={src && !failed ? undefined : "img"}
      aria-label={src && !failed ? undefined : (name ?? "User")}
    >
      {src && !failed ? (
        <img
          src={src}
          alt={name ?? "User avatar"}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">{initials}</span>
      )}
    </div>
  );
}
