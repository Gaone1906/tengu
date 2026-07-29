import { createContext, useContext } from 'react'

const EMPTY_TODO_PREFIXES: ReadonlySet<string> = new Set()

export const TodoPrefixContext = createContext<ReadonlySet<string>>(EMPTY_TODO_PREFIXES)

export function useKnownTodoPrefixes() {
  return useContext(TodoPrefixContext)
}
