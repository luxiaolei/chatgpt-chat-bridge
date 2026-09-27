import {spawn} from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;
const COMMANDS = new Set(["send", "read", "status", "stop", "list"]);

function text(value, name, {required = false, max = 4096} = {}) {
  if (value == null || value === "") {
    if (required) throw new TypeError(`${name} is required`);
    return null;
  }
  if (typeof value !== "string" || value.length > max) throw new TypeError(`${name} must be a string of at most ${max} characters`);
  return value;
}

function baseArgs(input = {}) {
  const args = [];
  const project = text(input.project, "project", {max: 512});
  const account = text(input.account, "account", {max: 128});
  if (project) args.push("--project", project);
  if (account) args.push("--account", account);
  if (input.task != null) args.push("--task", text(input.task, "task", {max: 256}));
  return args;
}

function parseJsonLine(value) {
  const lines = String(value || "").trim().split("\n").reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

function errorResponse(code, message, extra = {}) {
  return {ok: false, error: {code, message, ...extra}};
}

function run(binary, args, {env, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {env, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "", stderr = "", settled = false;
    const finish = (response) => { if (!settled) { settled = true; clearTimeout(timer); resolve(response); } };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(errorResponse("RUNTIME_SPAWN_FAILED", error.message)));
    child.on("close", (status, signal) => {
      const data = parseJsonLine(stdout);
      if (status === 0) return finish({ok: true, data: data ?? stdout.trim()});
      const detail = parseJsonLine(stderr) || parseJsonLine(stdout) || {};
      const attempted = detail.deliveryStage === "SEND_ATTEMPTED" || detail.code === "DELIVERY_UNCONFIRMED";
      finish(errorResponse(detail.code || (signal ? "RUNTIME_TERMINATED" : "BRIDGE_COMMAND_FAILED"),
        detail.reason || detail.message || stderr.trim() || `bridge exited with status ${status}`, {
          deliveryStage: detail.deliveryStage || (attempted ? "SEND_ATTEMPTED" : "PRE_SEND"),
          sendAttempted: attempted,
          status,
          signal,
          retryAfterSec: detail.retryAfterSec,
        }));
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(errorResponse("RUNTIME_TIMEOUT", "bridge command timed out", {sendAttempted: args[0] === "send", deliveryStage: args[0] === "send" ? "SEND_ATTEMPTED" : "PRE_SEND"}));
    }, timeoutMs);
  });
}

function unsupported(capability) {
  return errorResponse("UNSUPPORTED", `${capability} is not exposed by the runtime facade`, {capability});
}

export function createRuntime({bin = new URL("../bin/chat-bridge", import.meta.url).pathname, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  const runCommand = (args) => run(bin, args, {env: {...env}, timeoutMs});

  async function resolveRoute(input = {}) {
    try {
      input ||= {};
      const target = text(input.target ?? input.session ?? input.role, "target", {required: true, max: 512});
      const response = await runCommand(["list", ...baseArgs(input), "--all"]);
      if (!response.ok) return response;
      const sessions = Array.isArray(response.data) ? response.data : [];
      const matches = sessions.filter((session) => [session.id, session.name, session.role, session.alias, session.title].includes(target));
      if (matches.length !== 1) return errorResponse(matches.length ? "AMBIGUOUS_ROUTE" : "SESSION_NOT_FOUND", matches.length ? `multiple sessions match ${target}` : `no session matches ${target}`, {target, matches: matches.map((session) => session.id)});
      return {ok: true, route: {project: matches[0].project, account: matches[0].account, sessionRef: matches[0].id, role: matches[0].role || null, name: matches[0].name || null}};
    } catch (error) { return errorResponse("INVALID_INPUT", error.message); }
  }

  async function session(command, input = {}) {
    try {
      input ||= {};
      if (!COMMANDS.has(command) || command === "list") return errorResponse("INVALID_COMMAND", `unsupported session command: ${command}`);
      const target = text(input.target ?? input.session ?? input.role, "target", {required: true, max: 512});
      const args = [command, target];
      if (command === "send") {
        const message = text(input.message, "message", {required: true, max: 100_000});
        if (message.startsWith("--")) return errorResponse("INVALID_INPUT", "message cannot start with --");
        args.push(message);
      }
      args.push(...baseArgs(input));
      if (input.background === true) args.push("--background");
      return runCommand(args);
    } catch (error) { return errorResponse("INVALID_INPUT", error.message); }
  }

  return Object.freeze({
    capabilities: Object.freeze({resolveRoute: true, send: true, read: true, status: true, stop: true, attach: true, stream: false, toolResults: false, multimodal: false}),
    resolveRoute,
    send: (input) => session("send", input),
    read: (input) => session("read", input),
    status: (input) => session("status", input),
    stop: (input) => session("stop", input),
    attach: (input) => session("status", {...input, background: true}),
    stream: async () => unsupported("stream"),
    toolResults: async () => unsupported("toolResults"),
    multimodal: async () => unsupported("multimodal"),
  });
}

export const runtime = createRuntime();
