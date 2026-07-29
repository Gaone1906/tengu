import { describe, it, expect } from "vitest";
import {
  parsePermissionPrompt,
  chooseApproval,
  keystrokesToSelect,
} from "../claude-permission-prompt.js";

// The fixture below is NOT hand-written. It is the real terminal viewport from a
// live `claude 2.1.220` PTY that hit the hardcoded safety prompt while running
// with --dangerously-skip-permissions, replayed through the same headless xterm
// the gateway uses. Recorded 2026-07-29 while debugging a gateway session that
// had been wedged on this dialog for 9h26m.
const REAL_VIEWPORT = [
  "────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   set -e",
  "   W4=/private/tmp/claude-501/scratchpad/w4",
  "   for d in base revert plant; do",
  '     rm -rf "$W4/$d"; mkdir -p "$W4/$d"',
  "   done",
  '   echo "copies ready"; ls "$W4"',
  "   Set up three directories (base, revert, plant) in the work scratchpad",
  "",
  ' Dangerous rm operation on possibly-empty variable path: "$W4/$d"',
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
  "",
];

describe("parsePermissionPrompt", () => {
  it("recognises the real dangerous-rm prompt and reads its options", () => {
    const parsed = parsePermissionPrompt(REAL_VIEWPORT);
    expect(parsed).not.toBeNull();
    expect(parsed!.reason).toBe('Dangerous rm operation on possibly-empty variable path: "$W4/$d"');
    expect(parsed!.options).toEqual([
      { position: 0, printed: 1, label: "Yes", selected: true },
      { position: 1, printed: 2, label: "No", selected: false },
    ]);
    expect(parsed!.selectedPosition).toBe(0);
  });

  it("returns null for a viewport with no prompt", () => {
    expect(parsePermissionPrompt(["⏺ Bash(ls -la)", "  ⎿  Waiting…", ""])).toBeNull();
  });

  it("returns null when the option list is missing or too short", () => {
    expect(parsePermissionPrompt([" Do you want to proceed?", ""])).toBeNull();
    expect(parsePermissionPrompt([" Do you want to proceed?", " ❯ 1. Yes", ""])).toBeNull();
  });

  it("returns null when no cursor is present — a half-drawn frame is not answerable", () => {
    expect(parsePermissionPrompt([" Do you want to proceed?", "   1. Yes", "   2. No"])).toBeNull();
  });

  it("returns null when more than one cursor is present", () => {
    expect(parsePermissionPrompt([" Do you want to proceed?", " ❯ 1. Yes", " ❯ 2. No"])).toBeNull();
  });

  it("stops the option list at the first non-option line", () => {
    const parsed = parsePermissionPrompt([
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      " Esc to cancel · Tab to amend",
      "   3. Not an option — below the footer",
    ]);
    expect(parsed!.options).toHaveLength(2);
  });
});

describe("chooseApproval", () => {
  const parse = (lines: string[]) => parsePermissionPrompt(lines)!;

  it("picks Yes on the real prompt", () => {
    const target = chooseApproval(parse(REAL_VIEWPORT))!;
    expect(target.label).toBe("Yes");
    expect(target.position).toBe(0);
  });

  it("picks Yes even when it is not the option the cursor starts on", () => {
    const target = chooseApproval(parse([
      " Do you want to proceed?",
      " ❯ 1. No",
      "   2. Yes",
    ]))!;
    expect(target.position).toBe(1);
  });

  it("never picks a negative option, however it is phrased", () => {
    for (const label of ["No", "No, and tell Claude what to do differently", "Cancel", "Don't allow", "Exit"]) {
      const parsed = parse([" Do you want to proceed?", " ❯ 1. Yes", `   2. ${label}`]);
      expect(chooseApproval(parsed)!.label).toBe("Yes");
    }
  });

  it("returns null when nothing affirmative is on offer", () => {
    expect(chooseApproval(parse([
      " Do you want to proceed?",
      " ❯ 1. No",
      "   2. Cancel",
    ]))).toBeNull();
  });

  it("prefers a verbatim Yes when several affirmatives are offered", () => {
    const target = chooseApproval(parse([
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for rm commands",
    ]))!;
    expect(target.label).toBe("Yes");
  });

  it("returns null on ambiguous affirmatives with no verbatim Yes — stalling beats guessing", () => {
    expect(chooseApproval(parse([
      " Do you want to proceed?",
      " ❯ 1. Yes, allow once",
      "   2. Yes, and don't ask again",
    ]))).toBeNull();
  });
});

describe("keystrokesToSelect", () => {
  it("submits without moving when the cursor is already on the target", () => {
    expect(keystrokesToSelect(0, 0)).toEqual(["\r"]);
  });

  it("walks down to a later option", () => {
    expect(keystrokesToSelect(0, 2)).toEqual(["\x1b[B", "\x1b[B", "\r"]);
  });

  it("walks up to an earlier option", () => {
    expect(keystrokesToSelect(2, 1)).toEqual(["\x1b[A", "\r"]);
  });
});
