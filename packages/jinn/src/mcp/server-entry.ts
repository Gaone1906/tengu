#!/usr/bin/env node
/**
 * Launchable entry for the `jinn` MCP stdio server (GRS-012b).
 *
 * MCP-capable engines spawn this as a stdio subprocess (command = node, args =
 * [this file]) and speak JSON-RPC to it. It reads its gateway URL/token from the
 * inherited environment (see {@link runJinnMcpServer}); no argv secret.
 */
import { runJinnMcpServer } from "./server.js";

runJinnMcpServer();
