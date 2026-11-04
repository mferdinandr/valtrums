import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "w-full border-2 border-edge bg-black/50 px-3 py-2 font-term text-xl text-ink placeholder:text-mute focus:border-neon-cyan focus:outline-none focus:shadow-glow-cyan",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1 block font-pixel text-[9px] uppercase text-mute", className)} {...props} />;
}
