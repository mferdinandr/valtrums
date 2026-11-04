import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-block border-2 px-2 py-1 font-pixel text-[8px] uppercase leading-none", {
  variants: {
    tone: {
      green: "border-neon-green text-neon-green",
      pink: "border-neon-pink text-neon-pink",
      cyan: "border-neon-cyan text-neon-cyan",
      amber: "border-neon-amber text-neon-amber",
      red: "border-neon-red text-neon-red",
      mute: "border-edge text-mute",
    },
  },
  defaultVariants: { tone: "mute" },
});

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
