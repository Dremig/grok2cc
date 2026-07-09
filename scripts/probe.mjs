#!/usr/bin/env node
/** Quick tools/list probe against this MCP server (stdio). */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "server.mjs");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: process.env,
});

const client = new Client({ name: "probe", version: "0.1.0" });
await client.connect(transport);
const tools = await client.listTools();
console.log(JSON.stringify(tools, null, 2));
await client.close();
