import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The shadcn/ui class helper: merges conditional classes and resolves
 * conflicting Tailwind utilities so a caller's `className` reliably wins.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
