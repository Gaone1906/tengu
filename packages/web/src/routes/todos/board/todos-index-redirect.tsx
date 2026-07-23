import { Navigate, useLocation } from "react-router-dom"
import { DEFAULT_BOARD_PATH } from "./board-route"

/** Where a legacy /todos URL lands now that the board is the front door.
 *  Old deep links keep meaning what they meant: the needs-you lens maps to the
 *  Attention board; the people lens (retired with the legacy list at the
 *  stage-C cutover, superseded by department boards) lands on Everything —
 *  the whole-org view is its closest surviving meaning. Remaining search
 *  params ride along so filtered bookmarks stay filtered. Pure — unit-tested
 *  directly. */
export function legacyTodosRedirectTarget(search: string): string {
  const params = new URLSearchParams(search)
  const view = params.get("view")
  params.delete("view")
  const rest = params.toString()
  const suffix = rest ? `?${rest}` : ""
  if (view === "needs") return `/todos/b/attention${suffix}`
  if (view === "people") return `/todos/b/everything${suffix}`
  return `${DEFAULT_BOARD_PATH}${suffix}`
}

/** Route element for the /todos index: redirect into the board surface. */
export function TodosIndexRedirect() {
  const location = useLocation()
  return <Navigate to={legacyTodosRedirectTarget(location.search)} replace />
}
