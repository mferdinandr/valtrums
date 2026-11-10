import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "min-h-12 min-w-0 w-full rounded-xl border border-edge bg-void/70 px-4 py-3 font-term text-sm text-ink placeholder:text-mute focus:border-neon-green focus:outline-none focus:ring-2 focus:ring-neon-green/10",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        "mb-2 block font-pixel text-[11px] font-medium text-mute",
        className,
      )}
      {...props}
    />
  );
}
