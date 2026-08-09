import { useSettings } from "@/routes/settings-provider"
import { emojiForName } from "@/lib/emoji-pool"
import { colorForName } from "@/lib/color-pool"

interface EmployeeAvatarProps {
  name: string
  size?: number
  fontSize?: number
  className?: string
  style?: React.CSSProperties
  onClick?: () => void
}

export function EmployeeAvatar({
  name,
  size = 32,
  fontSize: fontSizeOverride,
  className,
  style,
  onClick,
}: EmployeeAvatarProps) {
  const { settings } = useSettings()
  const override = name ? settings.employeeOverrides[name] : undefined
  const emoji = override?.emoji || emojiForName(name || '')
  const color = override?.color || colorForName(name || '')
  const fontSize = fontSizeOverride ?? Math.round(size * 0.6)

  return (
    <span
      className={className}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize,
        lineHeight: 1,
        borderRadius: "50%",
        flexShrink: 0,
        cursor: onClick ? "pointer" : undefined,
        userSelect: "none",
        boxShadow: `0 0 0 2px ${color}`,
        ...style,
      }}
    >
      {emoji}
    </span>
  )
}

/** Standalone avatar preview without settings context (for pickers / settings page) */
export function AvatarPreview({
  name,
  size = 32,
  fontSize: fontSizeOverride,
  className,
  onClick,
  emoji: overrideEmoji,
  color: overrideColor,
}: EmployeeAvatarProps & { emoji?: string; color?: string }) {
  const emoji = overrideEmoji || emojiForName(name)
  const color = overrideColor || colorForName(name)
  const fontSize = fontSizeOverride ?? Math.round(size * 0.6)

  return (
    <span
      className={className}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        fontSize,
        lineHeight: 1,
        borderRadius: "50%",
        flexShrink: 0,
        cursor: onClick ? "pointer" : undefined,
        userSelect: "none",
        boxShadow: `0 0 0 2px ${color}`,
      }}
    >
      {emoji}
    </span>
  )
}
