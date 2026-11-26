import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names and resolves Tailwind conflicts (the shadcn/ui helper). */
export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));
