"use client";

import { useEffect, useRef, useState } from "react";

/**
 * IntersectionObserver hook.
 *
 * Returns [ref, isVisible]. Options: threshold, root, rootMargin, once
 * (stop observing after the first intersection).
 * Safe in SSR: no-op until mounted.
 */
export function useIntersection<T extends HTMLElement = HTMLDivElement>(
  options: IntersectionObserverInit & { once?: boolean } = {}
): [React.RefObject<T | null>, boolean] {
  const { once = false, ...init } = options;
  const ref = useRef<T | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const visible = entry ? entry.isIntersecting : false;
        setIsVisible(visible);
        if (visible && once) observer.disconnect();
      },
      init
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [init.root, init.rootMargin, init.threshold, once]);

  return [ref, isVisible];
}
