import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl border font-pixel text-xs font-semibold leading-none transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out motion-safe:active:translate-y-0.5 disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        primary:
          "border-[#ce806b] bg-[#f6ae96] text-[#623e40] shadow-[0_3px_0_#d18b76] hover:bg-[#ffc2a8]",
        pink: "border-[#cfadc3] bg-[#f5e4ee] text-neon-pink shadow-[0_3px_0_#dec4d4] hover:bg-[#efd6e5]",
        cyan: "border-[#a2c7c6] bg-[#d9eee9] text-neon-cyan shadow-[0_3px_0_#b2ceca] hover:bg-[#c5e6dc]",
        ghost:
          "border-edge bg-panel text-mute hover:border-neon-cyan/50 hover:text-ink",
      },
      size: {
        sm: "px-3 py-2",
        md: "px-4 py-3",
        lg: "px-6 py-4 text-xs",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
