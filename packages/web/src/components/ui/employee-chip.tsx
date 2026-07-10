import { EmployeeAvatar } from './employee-avatar'

interface EmployeeChipProps {
  employee: string
  displayName: string
  size?: 20 | 22 | 36
  showName?: boolean
  nameTone?: 'primary' | 'secondary'
  className?: string
}

export function EmployeeChip({
  employee,
  displayName,
  size = 22,
  showName = true,
  nameTone = 'secondary',
  className = '',
}: EmployeeChipProps) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-[var(--space-2)] ${className}`}>
      <EmployeeAvatar
        name={employee}
        size={size}
        fontSize={size === 36 ? 19 : 12}
        className="bg-[var(--fill-secondary)]"
      />
      {showName && (
        <span
          className={`truncate text-[length:var(--text-footnote)] font-[var(--weight-semibold)] ${
            nameTone === 'primary' ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'
          }`}
        >
          {displayName}
        </span>
      )}
    </span>
  )
}
