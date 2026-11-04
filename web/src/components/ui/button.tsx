import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 border-2 font-pixel text-[10px] uppercase leading-none transition-transform active:translate-x-[2px] active:translate-y-[2px] disabled:pointer-events-none disabled:opacity-40 shadow-pixel active:shadow-none",
  {
    variants: {
      variant: {
        primary: "border-neon-green bg-neon-green/10 text-neon-green hover:bg-neon-green hover:text-black",
        pink: "border-neon-pink bg-neon-pink/10 text-neon-pink hover:bg-neon-pink hover:text-black",
        cyan: "border-neon-cyan bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan hover:text-black",
        ghost: "border-edge bg-transparent text-mute hover:border-ink hover:text-ink",
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
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = "Button";
