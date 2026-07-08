---
name: sync
description: Sync the latest conversation with an employee into your context
---

# Sync Skill

## Trigger

This skill activates when the user sends `/sync @employee-name`. It pulls in the most recent conversation with the specified employee so you can respond with full awareness of what was discussed.

## How It Works

You fetch the latest employee conversation yourself using the Jinn MCP session tools. No magic injection - you're in control.

### Steps

1. **Extract the employee name** from the user's message (e.g., `/sync @jinn-dev` → `jinn-dev`)

2. **List that employee's sessions** with `jinn_list_sessions`:

```json
{ "scope": "employee", "employee": "EMPLOYEE_NAME", "limit": 10 }
```

Use the most recent relevant session from the returned summaries. If you need your own children instead, call `jinn_list_sessions` with `{ "scope": "children" }`.

3. **Read the latest conversation slice** with `jinn_read_session`:

```json
{ "sessionId": "SESSION_ID", "last": 20 }
```

Read the returned recent messages and status. `jinn_read_session` is intentionally capped; for very long conversations, ask the employee to summarize or write a report file, then read that artifact.

4. **Respond naturally** - summarize, highlight key points, offer next steps.

## Your Behavior

After fetching and reading the conversation:

1. **Summarize** the key points - what was discussed, what decisions were made, what work was done
2. **Highlight** any action items, blockers, or open questions
3. **Offer** to take next steps - continue the work, relay instructions, or loop in other employees

## Edge Cases

- **No sessions found**: If no sessions exist for that employee, tell the user: "I don't see any recent conversations with @employee-name."
- **Empty messages**: If the session exists but has no messages, note that the session was created but no conversation happened yet.
- **Employee not found**: If the name doesn't match any sessions, use `jinn_list_employees` or `jinn_find_employees` to suggest valid employee slugs.
- **Very long conversations**: Read the capped recent slice first. If that is insufficient, ask the employee to summarize or write a report file instead of pulling an unbounded transcript.

## Examples

User: `/sync @jinn-dev`
You: *[uses `jinn_list_sessions`, finds jinn-dev's latest session, reads recent messages with `jinn_read_session`]* "Here's what happened in the latest conversation with @jinn-dev: [summary]. Want me to follow up on anything?"

User: `/sync @content-writer`
You: *[uses MCP session tools]* "Looking at the recent chat with @content-writer - they finished the blog draft and are waiting for review. Should I ask them to make revisions, or is it ready to publish?"
