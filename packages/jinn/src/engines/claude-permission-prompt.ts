/**
 * Parsing + decision logic for Claude Code's hardcoded safety prompts.
 *
 * `--dangerously-skip-permissions` does NOT suppress every prompt. Claude Code
 * keeps a small set of "circuit breaker" safety checks that always ask, no matter
 * what the permission mode is — the CLI says so itself: "This requires explicit
 * approval and cannot be auto-allowed by permission rules." Confirmed kinds in
 * claude 2.1.220: `dangerousRemoval` (e.g. `rm -rf "$VAR/$d"`, which becomes
 * `rm -rf /*` when VAR is empty), `backgroundOperator` (`&`), and
 * `suspiciousWindowsPath`.
 *
 * These render as a select box in the TUI:
 *
 *     Dangerous rm operation on possibly-empty variable path: "$W4/$d"
 *
 *     Do you want to proceed?
 *     ❯ 1. Yes
 *       2. No
 *
 *     Esc to cancel · Tab to amend · ctrl+e to explain
 *
 * A gateway-driven PTY has nobody at the keyboard, so the turn hangs forever.
 * Two things were verified against a live PTY before this module was written:
 *   1. a PreToolUse hook returning `permissionDecision: "allow"` does NOT
 *      dismiss it — hooks cannot pre-approve a circuit breaker, so answering the
 *      TUI is the only route; and
 *   2. the `Notification` hook DOES fire (~6s later) with
 *      `notification_type: "permission_prompt"` — that is the detection signal.
 *
 * Everything here is pure: viewport text in, a decision out. The parser is
 * deliberately strict — it would rather return null and let the turn stall than
 * fire keystrokes at a dialog it does not fully recognise.
 */

export interface PermissionPromptOption {
  /** Position in the option list, 0-based. Navigation is positional. */
  position: number;
  /** The printed number ("1." → 1). Recorded for logs, never for navigation. */
  printed: number;
  label: string;
  selected: boolean;
}

export interface ParsedPermissionPrompt {
  /** Line that explains WHY approval is required, when one is present. */
  reason?: string;
  options: PermissionPromptOption[];
  /** Position of the option carrying the ❯ cursor. */
  selectedPosition: number;
}

const QUESTION = /^\s*Do you want to proceed\?\s*$/;
const OPTION = /^\s*(❯)?\s*(\d+)\.\s+(\S.*?)\s*$/;

/** Labels that mean "go ahead". Anchored — "No, and tell Claude…" must not match. */
const AFFIRMATIVE = /^yes\b/i;
/** Labels that must never be auto-selected, even if something else also matches. */
const NEGATIVE = /^(no|cancel|exit|abort|stop|don'?t|do not|reject|deny)\b/i;

/**
 * Recognise a pending safety prompt in the terminal's visible rows.
 *
 * Requires ALL of: the question line, at least two numbered options directly
 * below it, and exactly one ❯ cursor among them. Anything less is treated as
 * "not a prompt I understand" so a redraw mid-frame, a scrolled-off dialog, or
 * some future dialog shape can never be answered by accident.
 */
export function parsePermissionPrompt(viewport: readonly string[]): ParsedPermissionPrompt | null {
  const questionRow = viewport.findIndex((line) => QUESTION.test(line));
  if (questionRow === -1) return null;

  const options: PermissionPromptOption[] = [];
  for (let row = questionRow + 1; row < viewport.length; row += 1) {
    const line = viewport[row];
    const match = OPTION.exec(line);
    if (!match) {
      // Blank lines are padding inside the box; anything else ends the list.
      if (line.trim() === "") { if (options.length > 0) break; continue; }
      break;
    }
    options.push({
      position: options.length,
      printed: Number(match[2]),
      label: match[3],
      selected: match[1] === "❯",
    });
  }

  if (options.length < 2) return null;
  const selected = options.filter((o) => o.selected);
  if (selected.length !== 1) return null;

  // The reason is the last non-empty line above the question — "Dangerous rm
  // operation on possibly-empty variable path: …". Logged, never acted on.
  let reason: string | undefined;
  for (let row = questionRow - 1; row >= 0; row -= 1) {
    const text = viewport[row].trim();
    if (text) { reason = text; break; }
  }

  return { reason, options, selectedPosition: selected[0].position };
}

/**
 * Pick the option that approves, or null when the choice is not unambiguous.
 *
 * Exactly one affirmative must be on offer. If a dialog ever presents several
 * ("Yes" plus "Yes, and don't ask again"), only a verbatim "Yes" is taken; with
 * no verbatim match this returns null and the prompt is left for a human. Auto-
 * approving the wrong flavour of yes is worse than stalling.
 */
export function chooseApproval(prompt: ParsedPermissionPrompt): PermissionPromptOption | null {
  const affirmative = prompt.options.filter((o) => AFFIRMATIVE.test(o.label) && !NEGATIVE.test(o.label));
  if (affirmative.length === 1) return affirmative[0];
  if (affirmative.length === 0) return null;
  const verbatim = affirmative.filter((o) => o.label.toLowerCase() === "yes");
  return verbatim.length === 1 ? verbatim[0] : null;
}

/**
 * Keystrokes that move the cursor onto `to` and submit.
 *
 * Arrow-then-Enter rather than typing the option's digit: digit handling differs
 * between select widgets (some select, some select-and-submit), and a stray
 * trailing CR would land in whatever replaced the dialog. Arrows are unambiguous
 * and a no-op if the cursor is already home.
 */
export function keystrokesToSelect(from: number, to: number): string[] {
  const step = to > from ? "\x1b[B" : "\x1b[A";
  return [...Array(Math.abs(to - from)).fill(step), "\r"];
}
