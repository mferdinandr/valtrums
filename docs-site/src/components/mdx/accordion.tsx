"use client";

import { useRef, type MouseEvent, type ReactNode } from "react";

const OPEN_MS = 320;
const CLOSE_MS = 260;
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_IN_OUT = "cubic-bezier(0.65, 0, 0.35, 1)";

/**
 * A native `<details>` that opens and closes smoothly. The element and its open state stay native (keyboard,
 * find-in-page and screen readers behave the same); only the height and the body fade are animated.
 * Nothing is intercepted when the visitor prefers reduced motion.
 */
export function Accordion({ title, children }: { title: string; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const running = useRef<Animation | null>(null);

  const onSummaryClick = (event: MouseEvent<HTMLElement>) => {
    const el = details.current;
    const content = body.current;
    if (!el || !content || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    event.preventDefault();

    const summary = event.currentTarget;
    const startHeight = el.offsetHeight;
    running.current?.cancel();
    el.style.overflow = "hidden";

    const closing = el.open && el.dataset.state !== "closing";
    if (closing) {
      el.dataset.state = "closing";
      const style = getComputedStyle(el);
      const endHeight = summary.offsetHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      content.animate([{ opacity: 1 }, { opacity: 0 }], { duration: CLOSE_MS * 0.6, easing: "ease-in", fill: "forwards" });
      const anim = el.animate([{ height: `${startHeight}px` }, { height: `${endHeight}px` }], { duration: CLOSE_MS, easing: EASE_IN_OUT });
      running.current = anim;
      anim.onfinish = () => {
        el.open = false;
        el.dataset.state = "closed";
        el.style.overflow = "";
        content.getAnimations().forEach((a) => a.cancel());
        running.current = null;
      };
    } else {
      el.open = true;
      el.dataset.state = "open";
      const endHeight = el.scrollHeight;
      content.animate(
        [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: OPEN_MS - 40, delay: 50, easing: EASE_OUT, fill: "backwards" },
      );
      const anim = el.animate([{ height: `${startHeight}px` }, { height: `${endHeight}px` }], { duration: OPEN_MS, easing: EASE_OUT });
      running.current = anim;
      anim.onfinish = () => {
        el.style.overflow = "";
        running.current = null;
      };
    }
  };

  return (
    <details ref={details} className="accordion">
      <summary onClick={onSummaryClick}>{title}</summary>
      <div ref={body} className="accordion-body">
        {children}
      </div>
    </details>
  );
}
