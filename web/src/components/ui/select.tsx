"use client";

import { useEffect, useId, useRef, useState } from "react";
import gsap from "gsap";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SelectOption<T extends string> {
  value: T;
  title: string;
  description?: string;
}

/**
 * A listbox that opens with a short animation. It behaves like a native select: arrow keys move, Enter or Space
 * picks, Escape closes, and a click outside closes. Animation is skipped for visitors who prefer reduced motion.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  className,
}: {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const [active, setActive] = useState(selectedIndex);
  const current = options[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (!open || !list.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const el = list.current;
    const ctx = gsap.context(() => {
      gsap.fromTo(el, { autoAlpha: 0, y: -8, scaleY: 0.96, transformOrigin: "top" }, { autoAlpha: 1, y: 0, scaleY: 1, duration: 0.2, ease: "power2.out" });
      gsap.from(el.children, { autoAlpha: 0, y: -4, duration: 0.2, stagger: 0.04, delay: 0.05, ease: "power2.out" });
    }, el);
    return () => ctx.revert();
  }, [open]);

  const pick = (index: number) => {
    const o = options[index];
    if (o) onChange(o.value);
    setOpen(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      if (!open) {
        setActive(selectedIndex);
        setOpen(true);
      } else {
        setActive((i) => (i + step + options.length) % options.length);
      }
    } else if ((e.key === "Enter" || e.key === " ") && open) {
      e.preventDefault();
      pick(active);
    }
  };

  return (
    <div ref={root} className={cn("relative", className)}>
      <button
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        disabled={disabled}
        onClick={() => {
          setActive(selectedIndex);
          setOpen((v) => !v);
        }}
        onKeyDown={onKeyDown}
        className="flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border border-edge bg-void/70 px-4 py-3 text-left text-sm text-ink transition-colors hover:border-neon-green/60 focus:border-neon-green focus:outline-none focus:ring-2 focus:ring-neon-green/10 disabled:opacity-60"
      >
        <span className="min-w-0">
          <strong className="block font-semibold">{current?.title}</strong>
          {current?.description && <span className="block truncate text-xs text-mute">{current.description}</span>}
        </span>
        <ChevronDown size={18} aria-hidden="true" className={cn("shrink-0 transition-transform duration-200", open && "rotate-180")} />
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className="absolute left-0 right-0 z-30 mt-2 space-y-1 rounded-xl border border-edge bg-void p-1.5 shadow-xl"
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
              className={cn(
                "flex cursor-pointer items-start justify-between gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                i === active ? "bg-neon-green/10" : "",
              )}
            >
              <span className="min-w-0">
                <strong className="block font-semibold">{o.title}</strong>
                {o.description && <span className="block text-xs text-mute">{o.description}</span>}
              </span>
              {o.value === value && <Check size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-neon-green" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
