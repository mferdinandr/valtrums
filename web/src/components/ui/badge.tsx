import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-1.5 font-pixel text-[10px] font-medium uppercase tracking-wider leading-none",
  {
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
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
