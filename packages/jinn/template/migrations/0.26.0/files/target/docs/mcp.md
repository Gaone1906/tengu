# MCP (Model Context Protocol) Integration

{{portalName}} automatically configures MCP servers for AI engine sessions, giving employees access to browser automation, web search, and gateway tools without manual setup.

## How It Works

1. MCP servers are defined in `config.yaml` under the `mcp:` section
2. When a session starts, {{portalName}} resolves which MCP servers the employee needs
3. A temporary MCP config JSON file is written to `~/.jinn/tmp/mcp/`
4. The file is passed to Claude Code via `--mcp-config <path>`
5. The file is cleaned up after the session completes

## Built-in MCP Servers

### Browser (Playwright)
Full browser automation - navigate, click, type, screenshot, extract content.

```yaml
mcp:
  browser:
    enabled: true
    provider: playwright  # or "puppeteer"
```

### Web Search (Brave)
Search the web and get structured results.

```yaml
mcp:
  search:
    enabled: true
    provider: brave
    apiKey: ${BRAVE_API_KEY}  # reads from environment variable
```

### Fetch
Extract readable content from URLs (HTML → markdown/text).

```yaml
mcp:
  fetch:
    enabled: true
```

### Gateway (the `jinn` company toolset)
Built-in MCP server (named `jinn`) that wraps {{portalName}}'s own API. Gives
employees typed tools to discover colleagues, delegate work, spawn/read/message
sessions, and run workflows — instead of hand-written `curl` calls.

```yaml
mcp:
  gateway:
    enabled: false  # Optional global kill switch. When absent, the jinn toolset
                    # attaches to sessions on MCP-capable engines by default.
```

Attachment is decided per session from, in order: engine capability (an engine
without a per-session MCP lever never attaches) → the `enabled` master switch
(`false` beats everything; absent defaults on) → per-engine opt-out → an authed smoke check → the
per-employee override. At startup (and on every config reload), the gateway
verifies the builtin server can actually authenticate against itself — the same
bearer-from-`gateway.json` path a spawned server uses. If that check fails,
sessions spawn **without** the toolset and the reason is logged, rather than
spawning with tools whose every call fails.

Opt a single engine out (e.g. while its adapter misbehaves):

```yaml
mcp:
  gateway:
    enabled: true
    engines:
      grok: false   # grok sessions skip the jinn toolset; others keep it
```

## Custom MCP Servers

Add any MCP server via the `custom:` section:

```yaml
mcp:
  custom:
    my-database:
      enabled: true
      command: npx
      args: ["-y", "@my/mcp-server-postgres"]
      env:
        DATABASE_URL: ${DATABASE_URL}
    my-api:
      command: node
      args: ["/path/to/my-mcp-server.js"]
```

## Per-Employee Overrides

Employees can opt out of MCP servers or request only specific ones:

```yaml
# In employee YAML (e.g. org/engineering/backend-dev.yaml)
name: backend-dev
mcp: false  # No MCP servers at all

# Or specific servers only (the built-in gateway server is named `jinn`):
mcp:
  - search
  - jinn
```

The built-in `jinn` toolset additionally has its own per-employee override,
which beats the general `mcp` field (specific over general):

```yaml
# Force-attach for one employee (unless the global kill switch is false):
jinnMcp: true

# Or force-detach even when attachment is on gateway-wide:
jinnMcp: false
```

`mcp.gateway.enabled: false` (the kill switch) and a per-engine opt-out beat
`jinnMcp: true`.

By default, all globally enabled MCP servers are available to all employees.

## Environment Variables

API keys and secrets should use `${VAR_NAME}` syntax to reference environment variables:

```yaml
mcp:
  search:
    apiKey: ${BRAVE_API_KEY}
  custom:
    stripe:
      env:
        STRIPE_KEY: ${STRIPE_SECRET_KEY}
```

This keeps secrets out of config files.
