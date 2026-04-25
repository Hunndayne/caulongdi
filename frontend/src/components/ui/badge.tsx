import { cn } from "@/lib/utils";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "green" | "gray" | "red" | "blue" | "yellow";
  className?: string;
}

export function Badge({ children, variant = "gray", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
        {
          "bg-green-100 text-green-700": variant === "green",
          "bg-gray-100 text-gray-600": variant === "gray",
          "bg-red-100 text-red-600": variant === "red",
          "bg-blue-100 text-blue-700": variant === "blue",
          "bg-yellow-100 text-yellow-700": variant === "yellow",
        },
        className
      )}
    >
      {children}
    </span>
  );
}
