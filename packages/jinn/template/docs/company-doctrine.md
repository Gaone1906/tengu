# Company Doctrine

This doctrine is the product contract for running a company through {{portalName}}. It keeps the surface simple while the gateway handles the machinery underneath.

## 1. KISS/Minecraft

The system should feel like placing simple blocks, not operating a framework. Prefer a small set of memorable company concepts over exposing implementation machinery.

## 2. The Company Metaphor Is the API

Employees, Todos, Workflows, Chats, Notes, and Experiments are the public model. Internal objects can be richer, but users and agents should think in company terms: who owns work, what is pending, how work runs, where conversations happen, which Markdown knowledge should persist, and which bets are being measured.

Triggers are a Workflow detail: they bind supported wake-up events and polls to a reusable procedure. Notes are Markdown files below `knowledge/`; `docs/` remains read-only reference material.

## 3. Anti-Bottleneck

Fresh work should not ping the operator by default. Employees handle their lane, questions and approvals route up to managers and the COO, and the operator is reserved for explicit escalation: money, irreversible action, public action, legal/security risk, or COO request.

## 4. One Interface (MCP)

For company state, the Jinn MCP is the hands. Employees should use it to read and update org, sessions, Todos, Workflows, Notes, Experiments, cron, and reference material. Shell and filesystem access are for local implementation work or gaps the MCP does not cover.

## 5. Uniform Contracts

The same contract should hold everywhere: sources emit events, Workflow Triggers match events, Workflows run repeatable procedures, Todos are deliberately authored to record owned work, and Notes preserve Markdown knowledge. Avoid parallel concepts that do the same job in different shapes.

A Workflow invocation never creates, links, transitions, approves, or mutates a Todo. A Todo-status trigger is a one-way input; the resulting Workflow run is independent. Human gates use Workflow run approval, never Todo approval, and cancelling a Workflow run touches no Todo.

Workflow runs are durable records, not Sessions. Manual, schedule, event, Todo-status, and Workflow-call starts all enter the same durable runner.

## 6. Lean Identity Context

Prompt identity should say only what the session needs: who the employee is, where they sit in the hierarchy, what their hands are, how Todos and Workflows differ, and when to escalate. Everything else should be discovered on demand.

## 7. Contextual Relevance / Progressive Disclosure

The surface exposes the most relevant company state, not the firehose. Show what helps the current decision, then let employees drill into details through MCP, docs, or files when they need them.
