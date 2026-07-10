import type { ButtonHTMLAttributes } from 'react'

export function QuietCard({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-[var(--radius-xl)] border-none bg-[var(--fill-tertiary)] shadow-[var(--shadow-subtle)] transition-[background-color,scale] duration-150 ease-[var(--ease-smooth)] hover:bg-[var(--fill-secondary)] active:scale-[0.99] ${className}`}
    />
  )
}
