import { describe, it, expect } from 'vitest';
import { correlateSessionTurn, turnMarkerLinePrefix, type TurnLogRow } from '../advance.js';

/**
 * GRS-016e-fix (Codex finding 1) — the ONE row-positional correlator both the
 * gateway probe and the test harnesses consume. Correlation must anchor to
 * MESSAGE-ROW IDENTITY (the workflow's inserted user row), never to marker-string
 * content: an assistant echoing the marker is irrelevant by construction.
 */

const MARKER = 'wf-turn:run-x:node:r1:a1';
const line = (rest: string) => `${turnMarkerLinePrefix(MARKER)} ${rest}`;
const u = (id: string, content: string, partial = false): TurnLogRow => ({ id, role: 'user', content, ...(partial ? { partial } : {}) });
const a = (id: string, content: string, partial = false): TurnLogRow => ({ id, role: 'assistant', content, ...(partial ? { partial } : {}) });

describe('correlateSessionTurn — row-positional anchoring', () => {
  it('anchors by the persisted row id and returns the first assistant row after it', () => {
    const rows = [u('m1', 'earlier turn'), a('m2', 'earlier reply'), u('m3', line('do the step')), a('m4', 'the step reply')];
    const c = correlateSessionTurn(rows, { marker: MARKER, anchor: 'm3' });
    expect(c).toEqual({ markerPosted: true, replyText: 'the step reply' });
  });

  it('MARKER ECHO: an assistant row containing the full marker line is never the anchor and never breaks the settle', () => {
    const rows = [
      u('m1', line('do the step')),
      a('m2', `${line('acknowledged —')} ECHO-DONE`), // the Codex round-1 live repro shape
    ];
    // With the persisted anchor:
    expect(correlateSessionTurn(rows, { marker: MARKER, anchor: 'm1' }).replyText).toContain('ECHO-DONE');
  });

  it('NO CONTENT FALLBACK (Codex round-2, finding 3): a missing anchor NEVER correlates by marker-prefix content — not posted, no adoption', () => {
    // The reviewer's exact repro: the anchor was lost in the crash window and a
    // LATER user row carries the same marker-line prefix (stale/duplicate marker),
    // followed by an interloper reply. Content matching would anchor to the later
    // row and adopt OPERATOR-REPLY. The correlator must refuse to guess: no
    // durable row id → markerPosted false → the planner re-posts, never adopts.
    const rows = [
      u('m1', `${line('real workflow post')}`),
      u('m2', `${line('duplicate user marker after anchor was lost')}`),
      a('m3', 'OPERATOR-REPLY'),
    ];
    const noAnchor = correlateSessionTurn(rows, { marker: MARKER });
    expect(noAnchor.markerPosted).toBe(false);
    expect(noAnchor.replyText).toBeNull();
    // And WITH the true anchor the duplicate user row supersedes — still never adopted.
    const anchored = correlateSessionTurn(rows, { marker: MARKER, anchor: 'm1' });
    expect(anchored.superseded).toBe(true);
    expect(anchored.replyText).toBeNull();
  });

  it('an anchor row with NO assistant row after it reports null (settled-with-no-output evidence)', () => {
    const rows = [u('m1', 'op turn'), a('m2', 'op reply'), u('m3', line('do the step'))];
    const c = correlateSessionTurn(rows, { marker: MARKER, anchor: 'm3' });
    expect(c.markerPosted).toBe(true);
    expect(c.replyText).toBeNull(); // m2 (before the anchor) is never adopted
  });

  it('INTERRUPT SUPERSEDE: a user row intervening between the anchor and any assistant row marks the turn superseded — the next reply is NEVER adopted', () => {
    // The live race shape: the operator's message interrupted the workflow's
    // running turn (interruptOnNewMessage default), so the assistant row after it
    // belongs to the OPERATOR's turn. Structural rule: user row first → superseded.
    const rows = [u('m1', line('do the step')), u('m2', 'Operator here mid-race'), a('m3', 'OPERATOR-REPLY')];
    const c = correlateSessionTurn(rows, { marker: MARKER, anchor: 'm1' });
    expect(c.superseded).toBe(true);
    expect(c.replyText).toBeNull();
  });

  it('a user row AFTER the step reply is irrelevant (the turn completed first)', () => {
    const rows = [u('m1', line('do the step')), a('m2', 'the step reply'), u('m3', 'operator: later message'), a('m4', 'operator reply')];
    const c = correlateSessionTurn(rows, { marker: MARKER, anchor: 'm1' });
    expect(c.superseded).toBeUndefined();
    expect(c.replyText).toBe('the step reply');
  });

  it('notification rows (parent callbacks) never supersede — only user rows interrupt turns', () => {
    const rows: TurnLogRow[] = [
      u('m1', line('do the step')),
      { id: 'm2', role: 'notification', content: '📩 child replied' },
      a('m3', 'the step reply'),
    ];
    const c = correlateSessionTurn(rows, { marker: MARKER, anchor: 'm1' });
    expect(c.superseded).toBeUndefined();
    expect(c.replyText).toBe('the step reply');
  });

  it('partial assistant rows are skipped; the first NON-partial one settles', () => {
    const rows = [u('m1', line('do the step')), a('m2', 'streaming…', true), a('m3', 'final reply')];
    expect(correlateSessionTurn(rows, { marker: MARKER, anchor: 'm1' }).replyText).toBe('final reply');
  });

  it('no anchor id → not posted, even when a clean single marker-line user row exists (identity only, never content)', () => {
    const clean = [u('m1', line('the real post')), a('m2', 'reply')];
    expect(correlateSessionTurn(clean, { marker: MARKER })).toEqual({ markerPosted: false, replyText: null });
    const none = [u('m1', 'unrelated'), a('m2', `mentions ${MARKER} in passing`)];
    expect(correlateSessionTurn(none, { marker: MARKER })).toEqual({ markerPosted: false, replyText: null });
  });

  it('a stale anchor id that is not in the log → not posted (no content relocation; the planner re-posts)', () => {
    const rows = [u('m1', line('do the step')), a('m2', 'reply')];
    const c = correlateSessionTurn(rows, { marker: MARKER, anchor: 'gone-id' });
    expect(c).toEqual({ markerPosted: false, replyText: null });
  });
});
