"use client";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import gsap from "gsap";
export function RouteFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname(),
    ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pathname === "/") return;
    const context = gsap.context(() => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.fromTo(
          ".route-reveal",
          { y: 10, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 0.4,
            ease: "power2.out",
            clearProps: "all",
          },
        );
      });
    }, ref);
    return () => context.revert();
  }, [pathname]);
  if (pathname === "/") return <>{children}</>;
  if (/^\/arena\/[0-9]+$/.test(pathname)) return <div className="route-content">{children}</div>;
  return (
    <div ref={ref} className="route-content relative">
      <div key={pathname} className="route-reveal">
        {children}
      </div>
    </div>
  );
}
