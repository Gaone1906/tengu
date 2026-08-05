# MCP Integration

{{portalName}} attaches configured Model Context Protocol servers to supported engine sessions so employees can use typed tools without manual per-session setup.

## Resolution

1. Servers are declared under `mcp:` in `config.yaml`.
2. At session start, the gateway resolves global, engine, and employee settings.
3. It verifies that the built-in company server can authenticate.
4. It passes the resolved servers through the selected engine's supported MCP integration.
5. Any temporary integration files live under `$JINN_HOME/tmp/mcp/` and are cleaned after use.

The built-in server is named `jinn`. It exposes the company operating surface for employees, sessions, delegation, Todos, Workflows, cron reads, Notes, Experiments, approvals, reference data, and managed files.

## Built-in company tools

```yaml
mcp:
  gateway:
    enabled: true
    engines:
      grok: false
```

The gateway toolset attaches by default on MCP-capable engines. `enabled: false` is the global kill switch. Per-engine opt-outs apply next; an employee's `jinnMcp` override is most specific but cannot defeat the global kill switch or an engine that lacks MCP support. If the authentication smoke check fails, the session starts without the toolset and the gateway logs the reason.

## Custom servers

```yaml
mcp:
  custom:
    project-data:
      command: npx
      args: ["-y", "@example/project-data-mcp"]
      env:
        PROJECT_TOKEN: ${PROJECT_TOKEN}
```

Employees may opt out of every server with `mcp: false` or select server ids with an `mcp:` list. Use environment-variable references for secrets; never put literal credentials in this file or `config.yaml`.
