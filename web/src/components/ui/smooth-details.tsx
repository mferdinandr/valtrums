"use client";

import { useEffect } from "react";
import gsap from "gsap";

/**
 * Makes every `<details class="lifecycle-tech">` open and close smoothly. The markup and the native open state stay
 * as they are (so keyboard, find-in-page and screen readers behave the same); only the height and fade are
 * animated. Nothing is intercepted when the visitor prefers reduced motion.
 */
export function SmoothDetails() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onClick = (event: MouseEvent) => {
      if (reduce.matches) return;
      const summary = (event.target as Element | null)?.closest("summary");
      const details = summary?.parentElement;
      if (!summary || !(details instanceof HTMLDetailsElement) || !details.classList.contains("lifecycle-tech")) return;
      event.preventDefault();

      const body = Array.from(details.children).filter((el) => el !== summary) as HTMLElement[];
      const style = getComputedStyle(details);
      // Height of the closed element: the summary plus the details' own top padding and border.
      const closedHeight = () =>
        summary.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const opening = !(details.open && details.dataset.state !== "closing");

      gsap.killTweensOf([details, ...body]);
      details.style.overflow = "hidden";
      if (opening) {
        const from = details.offsetHeight;
        details.open = true;
        details.dataset.state = "open";
        const to = details.scrollHeight;
        gsap.fromTo(details, { height: from }, { height: to, duration: 0.32, ease: "power2.out", onComplete: () => { gsap.set(details, { clearProps: "height,overflow" }); } });
        gsap.fromTo(body, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.28, delay: 0.05, ease: "power2.out", clearProps: "opacity,visibility,transform" });
      } else {
        details.dataset.state = "closing";
        gsap.fromTo(details, { height: details.offsetHeight }, {
          height: closedHeight(),
          duration: 0.26,
          ease: "power2.inOut",
          onComplete: () => {
            details.open = false;
            details.dataset.state = "closed";
            gsap.set(details, { clearProps: "height,overflow" });
            gsap.set(body, { clearProps: "opacity,visibility,transform" });
          },
        });
        gsap.to(body, { autoAlpha: 0, duration: 0.15, ease: "power1.in" });
      }
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
