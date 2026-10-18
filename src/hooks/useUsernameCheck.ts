"use client";

import { useEffect, useState } from "react";
import { useDebounce } from "./useDebounce";

/**
 * Live username availability via GET /api/users/check-username.
 *
 * currentUsername: when provided, matching it counts as "idle" (unchanged).
 * Returns { state } where state is:
 *   idle | checking | available | taken | invalid
 */
export type UsernameCheckState = "idle" | "checking" | "available" | "taken" | "invalid";

export function useUsernameCheck(username: string, currentUsername?: string): {
  state: UsernameCheckState;
} {
  const debounced = useDebounce(username.trim().toLowerCase(), 400);
  const [state, setState] = useState<UsernameCheckState>("idle");

  useEffect(() => {
    if (!debounced || debounced === (currentUsername ?? "").toLowerCase()) {
      setState("idle");
      return;
    }
    if (!/^[a-z0-9_]{3,24}$/.test(debounced)) {
      setState("invalid");
      return;
    }
    let cancelled = false;
    setState("checking");
    fetch(`/api/users/check-username?username=${encodeURIComponent(debounced)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setState(data.available === true ? "available" : "taken");
      })
      .catch(() => {
        if (!cancelled) setState("idle");
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, currentUsername]);

  return { state };
}
