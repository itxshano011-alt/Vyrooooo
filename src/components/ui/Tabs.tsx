"use client";

import type { KeyboardEvent } from "react";

/**
 * Props: tabs ({ id, label }[]), activeId, onChange, ariaLabel.
 * Roving-tabindex tablist; arrow keys move between tabs.
 */
export function Tabs<T extends string>({
  tabs,
  activeId,
  onChange,
  ariaLabel = "Tabs",
}: {
  tabs: { id: T; label: string }[];
  activeId: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
}) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const idx = tabs.findIndex((t) => t.id === activeId);
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    if (next) {
      onChange(next.id);
      document.getElementById(`tab-${next.id}`)?.focus();
    }
  };

  return (
    <div role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown} className="flex gap-1">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
              active
                ? "bg-surface-elevated text-ink shadow-sm"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
