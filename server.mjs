#!/usr/bin/env node
/**
 * grok2claudecode — MCP server that exposes Grok Build CLI to Claude Code (and any MCP host).
 *
 * Tools:
 *   grok_delegate  — agentic coding task (writes files; uses --always-approve)
 *   grok_ask       — consult / second opinion (no auto-write; no always-approve)
 *   grok_review    — focused code review of a path or pasted diff
 *
 * Env:
 *   GROK_BIN              path to grok binary (default: "grok" on PATH)
 *   GROK_DEFAULT_MODEL    default -m value (optional)
 *   GROK_DEFAULT_CWD      default working directory (optional)
 *   GROK_TIMEOUT_MS       default subprocess timeout (default: 600000)
 */

import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const GROK_BIN = process.env.GROK_BIN || "grok";
const DEFAULT_MODEL = process.env.GROK_DEFAULT_MODEL || "";
const DEFAULT_CWD = process.env.GROK_DEFAULT_CWD || process.cwd();
const DEFAULT_TIMEOUT_MS = Number(process.env.GROK_TIMEOUT_MS || 600_000);

function runGrok({
  prompt,
  cwd,
  model,
  alwaysApprove,
  maxTurns,
  extraArgs = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const args = [
    "--no-auto-update",
    "--no-alt-screen",
    "-p",
    prompt,
    "--output-format",
    "plain",
  ];

  if (alwaysApprove) {
    // Agentic coding: auto-approve tool use so headless does not block.
    args.push("--always-approve");
  } else {
    // Consult/review: plan mode blocks most writes. Never leave headless on
    // default permission prompts — that hangs forever without a TTY.
    args.push("--permission-mode", "plan");
    args.push("--no-subagents");
  }

  const m = model || DEFAULT_MODEL;
  if (m) args.push("-m", m);
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  if (extraArgs.length) args.push(...extraArgs);

  const workdir = cwd || DEFAULT_CWD;

  return new Promise((resolve) => {
    const child = spawn(GROK_BIN, args, {
      cwd: workdir,
      env: {
        ...process.env,
        // Ensure local installs are visible when launched from GUI/Codex hosts.
        PATH: [
          process.env.HOME ? `${process.env.HOME}/.grok/bin` : "",
          process.env.HOME ? `${process.env.HOME}/.nvm/versions/node/v24.10.0/bin` : "",
          process.env.PATH || "",
        ]
          .filter(Boolean)
          .join(":"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
      finish({
        ok: false,
        code: null,
        timedOut: true,
        cwd: workdir,
        command: `${GROK_BIN} ${args.map(shellQuote).join(" ")}`,
        stdout: stdout.slice(-80_000),
        stderr: (stderr + `\n[timeout after ${timeoutMs}ms]`).slice(-20_000),
      });
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
      if (stdout.length > 400_000) stdout = stdout.slice(-300_000);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      if (stderr.length > 100_000) stderr = stderr.slice(-80_000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        ok: false,
        code: null,
        timedOut: false,
        cwd: workdir,
        command: `${GROK_BIN} ${args.map(shellQuote).join(" ")}`,
        stdout,
        stderr: String(err),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        ok: code === 0,
        code,
        timedOut: false,
        cwd: workdir,
        command: `${GROK_BIN} ${args.map(shellQuote).join(" ")}`,
        stdout: stdout.slice(-80_000),
        stderr: stderr.slice(-20_000),
      });
    });
  });
}

function shellQuote(s) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function formatResult(result) {
  const parts = [
    `ok=${result.ok}`,
    `exit=${result.code}`,
    `cwd=${result.cwd}`,
    result.timedOut ? "timedOut=true" : null,
    `command=${result.command}`,
    "",
    "--- stdout ---",
    result.stdout?.trim() || "(empty)",
  ];
  if (result.stderr?.trim()) {
    parts.push("", "--- stderr ---", result.stderr.trim());
  }
  return parts.filter((x) => x !== null).join("\n");
}

const server = new McpServer({
  name: "grok2claudecode",
  version: "0.1.0",
});

const commonShape = {
  prompt: z.string().describe("Task or question for Grok Build"),
  cwd: z
    .string()
    .optional()
    .describe("Working directory (absolute path). Defaults to GROK_DEFAULT_CWD or process cwd."),
  model: z
    .string()
    .optional()
    .describe("Grok model id, e.g. grok-build. Empty = CLI default."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Subprocess timeout in milliseconds (default 600000)."),
  max_turns: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional --max-turns for the Grok agent loop."),
};

server.tool(
  "grok_delegate",
  "Delegate an agentic coding task to Grok Build CLI (headless). Grok may read/write files and run shell commands with --always-approve. Use for implementation, refactors, fixes. Prefer a dedicated worktree when changes are risky.",
  commonShape,
  async (args) => {
    const result = await runGrok({
      prompt: args.prompt,
      cwd: args.cwd,
      model: args.model,
      alwaysApprove: true,
      maxTurns: args.max_turns,
      timeoutMs: args.timeout_ms || DEFAULT_TIMEOUT_MS,
    });
    return {
      content: [{ type: "text", text: formatResult(result) }],
      isError: !result.ok,
    };
  }
);

server.tool(
  "grok_ask",
  "Ask Grok Build for analysis, design, or a second opinion without auto-approving writes. Good for architecture questions, explanations, and read-only investigation. Do not use when you need Grok to apply code changes.",
  commonShape,
  async (args) => {
    const result = await runGrok({
      prompt: args.prompt,
      cwd: args.cwd,
      model: args.model,
      alwaysApprove: false,
      maxTurns: args.max_turns ?? 20,
      timeoutMs: args.timeout_ms || DEFAULT_TIMEOUT_MS,
    });
    return {
      content: [{ type: "text", text: formatResult(result) }],
      isError: !result.ok,
    };
  }
);

server.tool(
  "grok_review",
  "Run a focused code review with Grok Build. Provide either a filesystem path or paste a diff/snippet in the prompt. Returns findings only; does not auto-apply fixes.",
  {
    ...commonShape,
    path: z
      .string()
      .optional()
      .describe("Optional file or directory path to review (relative to cwd or absolute)."),
  },
  async (args) => {
    const reviewPrompt = [
      "You are performing a careful code review.",
      "Focus on bugs, security issues, race conditions, missing tests, and API misuse.",
      "Be specific: cite files/lines when possible.",
      "Do NOT modify files. Output a structured review only.",
      args.path ? `Review target path: ${args.path}` : null,
      "",
      args.prompt,
    ]
      .filter(Boolean)
      .join("\n");

    const result = await runGrok({
      prompt: reviewPrompt,
      cwd: args.cwd,
      model: args.model,
      alwaysApprove: false,
      maxTurns: args.max_turns ?? 30,
      timeoutMs: args.timeout_ms || DEFAULT_TIMEOUT_MS,
    });
    return {
      content: [{ type: "text", text: formatResult(result) }],
      isError: !result.ok,
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
