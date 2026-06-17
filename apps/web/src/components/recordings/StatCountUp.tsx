"use client";

import { useEffect, useState } from "react";

/**
 * Simple count-up for the stat cards. No libraries. Respects
 * prefers-reduced-motion by showing the final value directly.
 */
interface StatCountUpProps {
  value: number;
  suffix?: string;
  delayMs?: number;
  durationMs?: number;
}

export default function StatCountUp({
  value,
  suffix = "",
  delayMs = 0,
  durationMs = 600,
}: StatCountUpProps) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce || value <= 0) {
      setDisplay(value);
      return;
    }

    let raf = 0;
    let start = 0;
    const timer = window.setTimeout(() => {
      const step = (ts: number) => {
        if (!start) start = ts;
        const progress = Math.min(1, (ts - start) / durationMs);
        setDisplay(Math.round(value * progress));
        if (progress < 1) raf = window.requestAnimationFrame(step);
      };
      raf = window.requestAnimationFrame(step);
    }, delayMs);

    return () => {
      window.clearTimeout(timer);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [value, delayMs, durationMs]);

  return (
    <>
      {display}
      {suffix}
    </>
  );
}
