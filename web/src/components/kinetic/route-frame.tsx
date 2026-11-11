"use client";
import { usePathname } from "next/navigation";
import { useEffect, useRef, type ReactNode } from "react";
import gsap from "gsap";
import { config } from "@/lib/config";
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
  return (
    <div ref={ref} className="route-content relative">
      <p className="mb-5 flex items-center gap-2 text-xs text-mute">
        <span className="status-dot" />
        {config.network}
      </p>
      <div key={pathname} className="route-reveal">
        {children}
      </div>
    </div>
  );
}
