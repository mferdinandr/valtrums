"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import gsap from "gsap";

/** A thin bar at the top of the page: it starts when an internal link is clicked and finishes when the page changes. */
export function RouteProgress() {
  const bar = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const last = useRef(pathname);
  const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!bar.current || calm()) return;
      gsap.killTweensOf(bar.current);
      gsap.set(bar.current, { scaleX: 0.05, opacity: 1 });
      gsap.to(bar.current, { scaleX: 0.85, duration: 6, ease: "power2.out" });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    if (last.current === pathname) return;
    last.current = pathname;
    if (!bar.current || calm()) return;
    gsap.killTweensOf(bar.current);
    gsap.to(bar.current, { scaleX: 1, duration: 0.2, ease: "power1.out" });
    gsap.to(bar.current, { opacity: 0, duration: 0.3, delay: 0.2, onComplete: () => { if (bar.current) gsap.set(bar.current, { scaleX: 0 }); } });
  }, [pathname]);

  return <div ref={bar} className="route-progress" aria-hidden="true" />;
}
