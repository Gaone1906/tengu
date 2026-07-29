import { useMemo } from "react"
import { useDepartments } from "@/hooks/use-departments"
import { useOnboarding } from "@/hooks/use-onboarding"

const EMPTY_TODO_PREFIXES: ReadonlySet<string> = new Set()

export function useTodoPrefixes(): ReadonlySet<string> {
  const onboarding = useOnboarding()
  const departments = useDepartments()

  return useMemo(() => {
    if (!onboarding.data || !departments.data) return EMPTY_TODO_PREFIXES

    const prefixes = new Set<string>()
    if (onboarding.data.todoPrefix) prefixes.add(onboarding.data.todoPrefix)
    for (const department of departments.data) prefixes.add(department.prefix)
    return prefixes
  }, [departments.data, onboarding.data])
}
