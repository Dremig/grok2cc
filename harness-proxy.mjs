#!/usr/bin/env node
/**
 * Claude Code harness → xAI Anthropic-compatible /v1/messages
 *
 * Why a proxy (not raw api.x.ai):
 * 1) xAI only accepts Authorization: Bearer; Claude's ANTHROPIC_API_KEY is x-api-key
 * 2) xAI tool JSON Schema is stricter: `required` MUST be an array (use [] if none)
 * 3) Inject token from ~/.grok/auth.json (or XAI_API_KEY)
 * 4) Strip empty thinking blocks / map Claude model aliases
 *
 * Usage:
 *   node harness-proxy.mjs
 *   # then:
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8790 ANTHROPIC_API_KEY=grok-harness claude
 */

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

const HOST = process.env.GROK_HARNESS_HOST || "127.0.0.1";
const PORT = Number(process.env.GROK_HARNESS_PORT || 8790);
const UPSTREAM = (process.env.GROK_HARNESS_UPSTREAM || "https://api.x.ai").replace(/\/+$/, "");
const AUTH_PATH = process.env.GROK_AUTH_JSON || path.join(os.homedir(), ".grok", "auth.json");
const DEFAULT_MODEL = process.env.GROK_HARNESS_DEFAULT_MODEL || "grok-4.5";
const LOG = process.env.GROK_HARNESS_LOG === "1";
const STRIP_THINKING = process.env.GROK_HARNESS_STRIP_THINKING !== "0";
const STRIP_BETA_FIELDS = process.env.GROK_HARNESS_STRIP_BETA !== "0";

function log(...args) {
  if (LOG) console.error(new Date().toISOString(), ...args);
}

function readGrokToken() {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;
  if (process.env.GROK_HARNESS_TOKEN) return process.env.GROK_HARNESS_TOKEN;
  if (!fs.existsSync(AUTH_PATH)) {
    throw new Error(`No token: set XAI_API_KEY or run \`grok login\` (${AUTH_PATH})`);
  }
  const raw = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8"));
  const entry = Object.values(raw)[0];
  if (!entry?.key) throw new Error(`No key in ${AUTH_PATH}`);
  if (entry.expires_at) {
    const exp = Date.parse(entry.expires_at);
    if (Number.isFinite(exp) && exp < Date.now()) {
      console.error(
        `[harness-proxy] WARNING: grok token expired at ${entry.expires_at}. Run: grok login`
      );
    }
  }
  return entry.key;
}

/**
 * xAI MessageToolInputSchema is picky:
 * - properties: required field
 * - required: must be array (missing/null → 400 "/required: null is not of type array")
 */
function sanitizeSchema(schema, depth = 0) {
  if (depth > 24) return { type: "object", properties: {}, required: [] };
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {}, required: [] };
  }

  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (
      k === "$schema" ||
      k === "$id" ||
      k === "$defs" ||
      k === "definitions" ||
      k === "additionalProperties" ||
      k === "unevaluatedProperties" ||
      k === "examples" ||
      k === "default"
    ) {
      continue;
    }
    if (k === "required") continue; // re-add below
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([pk, pv]) => [pk, sanitizeSchema(pv, depth + 1)])
      );
      continue;
    }
    if (k === "items" && v && typeof v === "object") {
      out.items = sanitizeSchema(v, depth + 1);
      continue;
    }
    if (k === "type" && Array.isArray(v)) {
      const cleaned = v.filter((t) => t !== "null");
      out.type = cleaned.length === 1 ? cleaned[0] : cleaned.length ? cleaned : "object";
      continue;
    }
    out[k] = v;
  }

  if (!out.type && (out.properties || depth === 0)) out.type = "object";
  if (out.type === "object" || out.properties) {
    if (!out.properties || typeof out.properties !== "object") out.properties = {};
    // Always array. Prefer original required names that still exist.
    const origReq = Array.isArray(schema.required) ? schema.required : [];
    out.required = origReq.filter((n) => typeof n === "string" && n in out.properties);
  }
  return out;
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content
    .map((b) => {
      if (typeof b === "string") return b;
      if (!b || typeof b !== "object") return "";
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (typeof b.text === "string") return b.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function normalizeSystemField(system) {
  if (system == null) return [];
  if (typeof system === "string") {
    return system ? [{ type: "text", text: system }] : [];
  }
  if (Array.isArray(system)) {
    return system
      .map((b) => {
        if (typeof b === "string") return { type: "text", text: b };
        if (b && typeof b === "object" && b.type === "text") return b;
        if (b && typeof b === "object" && typeof b.text === "string") {
          return { type: "text", text: b.text };
        }
        return null;
      })
      .filter(Boolean);
  }
  return [{ type: "text", text: String(system) }];
}

/**
 * xAI Anthropic-compat only accepts message roles: user | assistant.
 * Claude Code / other harnesses may send system | developer | tool.
 */
function sanitizeMessages(body) {
  if (!Array.isArray(body.messages)) return body;

  const systemExtra = [];
  const out = [];

  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object") continue;
    let role = msg.role;
    let content = msg.content;

    // Fold system/developer into top-level `system`
    if (role === "system" || role === "developer") {
      const text = contentToText(content);
      if (text) systemExtra.push({ type: "text", text });
      continue;
    }

    // OpenAI-style tool role → Anthropic tool_result on user message
    if (role === "tool") {
      const toolUseId = msg.tool_use_id || msg.tool_call_id || msg.id;
      const resultContent =
        typeof content === "string" || Array.isArray(content)
          ? content
          : contentToText(content);
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseId || "tool_call",
            content: resultContent,
          },
        ],
      });
      continue;
    }

    // Unknown roles → user text (better than hard-fail)
    if (role !== "user" && role !== "assistant") {
      const text = contentToText(content);
      out.push({
        role: "user",
        content: text
          ? `[(normalized from role=${role})] ${text}`
          : `[(empty message from role=${role})]`,
      });
      continue;
    }

    if (STRIP_THINKING && Array.isArray(content)) {
      content = content.filter(
        (b) => b && b.type !== "thinking" && b.type !== "redacted_thinking"
      );
      if (!content.length) {
        content = role === "assistant" ? [{ type: "text", text: "" }] : [{ type: "text", text: "" }];
      }
    }

    out.push({ ...msg, role, content });
  }

  // Merge extracted system prompts
  if (systemExtra.length) {
    const existing = normalizeSystemField(body.system);
    body.system = [...existing, ...systemExtra];
  }

  // Drop empty system
  if (Array.isArray(body.system) && body.system.length === 0) {
    delete body.system;
  }

  body.messages = out;
  return body;
}

function rewriteBody(buf, contentType) {
  if (!buf?.length) return buf;
  if (!contentType || !String(contentType).includes("application/json")) return buf;
  let body;
  try {
    body = JSON.parse(buf.toString("utf8"));
  } catch {
    return buf;
  }

  if (body && typeof body.model === "string") {
    const m = body.model.toLowerCase();
    if (m.includes("claude") || m === "sonnet" || m === "opus" || m === "haiku") {
      body.model = DEFAULT_MODEL;
    }
  }

  if (Array.isArray(body.tools)) {
    body.tools = body.tools.map((t) => {
      if (!t || typeof t !== "object") return t;
      return {
        name: t.name,
        description: t.description || t.name || "tool",
        input_schema: sanitizeSchema(t.input_schema || t.inputSchema || {}),
      };
    });
  }

  body = sanitizeMessages(body);

  // Optional: drop Claude-only beta request fields that some gateways reject.
  if (process.env.GROK_HARNESS_STRIP_BETA === "1") {
    delete body.thinking;
    delete body.context_management;
    delete body.output_config;
    delete body.metadata;
  }

  return Buffer.from(JSON.stringify(body), "utf8");
}

function proxy(req, res) {
  const start = Date.now();
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    let token;
    try {
      token = readGrokToken();
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "auth_error", message: String(err.message || err) },
        })
      );
      return;
    }

    // Health-style HEAD
    if (req.method === "HEAD") {
      res.writeHead(200);
      res.end();
      return;
    }

    const rawBody = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] || "application/json";
    const body = rewriteBody(rawBody, contentType);

    // Debug dumps (always write last rewritten body; dump raw on 4xx)
    try {
      fs.writeFileSync("/tmp/grok2cc-last-request.json", body);
    } catch {
      /* ignore */
    }

    const upstreamUrl = new URL(req.url || "/", UPSTREAM + "/");
    // Ensure path stays under upstream origin
    const isHttps = upstreamUrl.protocol === "https:";
    const lib = isHttps ? https : http;

    const headers = {
      "content-type": contentType,
      "content-length": String(body.length),
      authorization: `Bearer ${token}`,
      "anthropic-version":
        req.headers["anthropic-version"] || req.headers["Anthropic-Version"] || "2023-06-01",
    };
    // Forward anthropic beta headers
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.startsWith("anthropic-") || k === "user-agent") headers[k] = v;
    }
    headers.authorization = `Bearer ${token}`;

    const preq = lib.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: upstreamUrl.pathname + upstreamUrl.search,
        method: req.method,
        headers,
      },
      (pres) => {
        const status = pres.statusCode || 502;
        if (status >= 400) {
          try {
            fs.writeFileSync("/tmp/grok2cc-last-raw-request.json", rawBody);
            fs.writeFileSync("/tmp/grok2cc-last-rewritten-request.json", body);
          } catch {
            /* ignore */
          }
          const errChunks = [];
          pres.on("data", (c) => errChunks.push(c));
          pres.on("end", () => {
            const errBody = Buffer.concat(errChunks);
            try {
              fs.writeFileSync("/tmp/grok2cc-last-error.json", errBody);
            } catch {
              /* ignore */
            }
            log(req.method, req.url, status, `${Date.now() - start}ms`, errBody.toString("utf8").slice(0, 300));
            if (!res.headersSent) {
              res.writeHead(status, { "content-type": "application/json" });
            }
            res.end(errBody);
          });
          return;
        }
        res.writeHead(status, pres.headers);
        pres.pipe(res);
        pres.on("end", () => log(req.method, req.url, status, `${Date.now() - start}ms`));
      }
    );
    preq.on("error", (err) => {
      console.error("[harness-proxy] upstream error", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "api_error", message: `upstream: ${err.message}` },
          })
        );
      } else res.end();
    });
    preq.write(body);
    preq.end();
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health" || req.url?.startsWith("/health?"))) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "grok-claude-harness-proxy",
        upstream: UPSTREAM,
        defaultModel: DEFAULT_MODEL,
        auth: fs.existsSync(AUTH_PATH)
          ? "grok-auth.json"
          : process.env.XAI_API_KEY
            ? "XAI_API_KEY"
            : "missing",
      })
    );
    return;
  }
  if (req.method === "HEAD") {
    res.writeHead(200);
    res.end();
    return;
  }
  proxy(req, res);
});

server.listen(PORT, HOST, () => {
  console.error(`[harness-proxy] http://${HOST}:${PORT} → ${UPSTREAM} (default model ${DEFAULT_MODEL})`);
  console.error(
    `[harness-proxy] Claude: ANTHROPIC_BASE_URL=http://${HOST}:${PORT} ANTHROPIC_API_KEY=grok-harness`
  );
});
