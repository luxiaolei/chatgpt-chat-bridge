import {spawn} from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;
const COMMANDS = new Set(["send", "read", "status", "stop", "ask", "list"]);
const TURN_EVENT_TYPES = new Set(["delta", "progress", "terminal"]);

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
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const lines = trimmed.split("\n").reverse();
  for (const line of lines) {
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

function errorResponse(code, message, extra = {}) {
  return {ok: false, error: {code, message, ...extra}};
}

function createTurnEventStream({requestId, turnId, assistantMessageId = null} = {}) {
  if (typeof requestId !== "string" || !requestId || typeof turnId !== "string" || !turnId) throw new TypeError("requestId and turnId are required");
  if (assistantMessageId != null && (typeof assistantMessageId !== "string" || !assistantMessageId)) throw new TypeError("assistantMessageId must be a non-empty string");
  let lastSequence = 0;
  let terminal = false;
  return Object.freeze({
    push(event = {}) {
      if (event.requestId !== requestId || event.turnId !== turnId) return errorResponse("TURN_CORRELATION_MISMATCH", "turn event does not match request or turn", {requestId, turnId});
      if (terminal) return errorResponse("EVENT_AFTER_TERMINAL", "turn event arrived after terminal event", {requestId, turnId, sequence: event.sequence ?? null});
      if (!Number.isInteger(event.sequence) || event.sequence < 1) return errorResponse("INVALID_TURN_SEQUENCE", "sequence must be a positive integer", {requestId, turnId});
      if (event.sequence <= lastSequence) return errorResponse("STALE_TURN_EVENT", "turn event sequence is stale", {requestId, turnId, sequence: event.sequence, lastSequence});
      if (event.sequence !== lastSequence + 1) return errorResponse("TURN_SEQUENCE_GAP", "turn event sequence has a gap", {requestId, turnId, sequence: event.sequence, expected: lastSequence + 1});
      if (!TURN_EVENT_TYPES.has(event.type)) return errorResponse("INVALID_TURN_EVENT_TYPE", "type must be delta, progress, or terminal", {requestId, turnId, sequence: event.sequence});
      if (event.type === "delta") {
        if (typeof event.delta !== "string") return errorResponse("INVALID_TURN_DELTA", "delta events require string delta", {requestId, turnId, sequence: event.sequence});
        if (assistantMessageId && event.assistantMessageId !== assistantMessageId) return errorResponse("STALE_ASSISTANT_CONTENT", "delta is from a different assistant message", {requestId, turnId, sequence: event.sequence, assistantMessageId: event.assistantMessageId ?? null});
      }
      if (event.type === "progress" && (!event.progress || typeof event.progress !== "object")) return errorResponse("INVALID_TURN_PROGRESS", "progress events require an object", {requestId, turnId, sequence: event.sequence});
      if (event.type === "terminal" && (!event.terminal || typeof event.terminal !== "object")) return errorResponse("INVALID_TURN_TERMINAL", "terminal events require an object", {requestId, turnId, sequence: event.sequence});
      lastSequence = event.sequence;
      if (event.type === "terminal") terminal = true;
      return {ok: true, event: {...event}};
    },
    state() { return {requestId, turnId, lastSequence, terminal, assistantMessageId}; },
  });
}

function createToolResultStream({requestId, turnId, toolCallId, toolName, schemaId} = {}) {
  for (const [name, value] of Object.entries({requestId, turnId, toolCallId, toolName, schemaId})) {
    if (typeof value !== "string" || !value) throw new TypeError(`${name} is required`);
  }
  let lastSequence = 0;
  let terminal = false;
  const seenResultIds = new Set();
  return Object.freeze({
    push(event = {}) {
      if (event.requestId !== requestId || event.turnId !== turnId || event.toolCallId !== toolCallId) return errorResponse("TOOL_RESULT_CORRELATION_MISMATCH", "tool result does not match request, turn, or tool call", {requestId, turnId, toolCallId});
      if (event.resultId && seenResultIds.has(event.resultId)) return errorResponse("DUPLICATE_TOOL_RESULT", "tool result ID was already accepted", {requestId, turnId, toolCallId, resultId: event.resultId});
      if (terminal) return errorResponse("TOOL_RESULT_AFTER_TERMINAL", "tool result arrived after terminal result", {requestId, turnId, toolCallId, sequence: event.sequence ?? null});
      if (!Number.isInteger(event.sequence) || event.sequence < 1) return errorResponse("INVALID_TOOL_SEQUENCE", "sequence must be a positive integer", {requestId, turnId, toolCallId});
      if (event.sequence <= lastSequence) return errorResponse("STALE_TOOL_RESULT", "tool result sequence is stale", {requestId, turnId, toolCallId, sequence: event.sequence, lastSequence});
      if (event.sequence !== lastSequence + 1) return errorResponse("TOOL_SEQUENCE_GAP", "tool result sequence has a gap", {requestId, turnId, toolCallId, sequence: event.sequence, expected: lastSequence + 1});
      if (!["progress", "result", "error"].includes(event.type)) return errorResponse("INVALID_TOOL_RESULT_TYPE", "type must be progress, result, or error", {requestId, turnId, toolCallId, sequence: event.sequence});
      if (event.type === "progress") {
        if (!event.progress || typeof event.progress !== "object") return errorResponse("INVALID_TOOL_PROGRESS", "progress events require an object", {requestId, turnId, toolCallId, sequence: event.sequence});
      } else {
        if (event.toolName !== toolName || event.schemaId !== schemaId) return errorResponse("TOOL_BINDING_MISMATCH", "tool result name or schema does not match the tool call", {requestId, turnId, toolCallId, expectedToolName: toolName, expectedSchemaId: schemaId});
        if (typeof event.resultId !== "string" || !event.resultId) return errorResponse("INVALID_TOOL_RESULT_ID", "result and error events require resultId", {requestId, turnId, toolCallId, sequence: event.sequence});
        if (event.type === "result" && !Object.hasOwn(event, "result")) return errorResponse("INVALID_TOOL_RESULT", "result events require result", {requestId, turnId, toolCallId, sequence: event.sequence});
        if (event.type === "error" && (!event.error || typeof event.error !== "object" || typeof event.error.code !== "string" || typeof event.error.message !== "string")) return errorResponse("INVALID_TOOL_ERROR", "error events require error.code and error.message", {requestId, turnId, toolCallId, sequence: event.sequence});
      }
      lastSequence = event.sequence;
      if (event.type !== "progress") {
        terminal = true;
        seenResultIds.add(event.resultId);
      }
      return {ok: true, event: {...event}};
    },
    state() { return {requestId, turnId, toolCallId, toolName, schemaId, lastSequence, terminal, resultIds: [...seenResultIds]}; },
  });
}

function run(binary, args, {env, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {env, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "", stderr = "", settled = false;
    const finish = (response) => { if (!settled) { settled = true; clearTimeout(timer); resolve(response); } };
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      const disconnected = ["EPIPE", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(error.code);
      finish(errorResponse(disconnected ? "RUNTIME_DISCONNECTED" : "RUNTIME_SPAWN_FAILED", error.message, {localProcess: "unknown", remoteGeneration: "unknown", systemCode: error.code || null}));
    });
    child.on("close", (status, signal) => {
      const data = parseJsonLine(stdout);
      if (status === 0) return finish({ok: true, data: data ?? stdout.trim()});
      const detail = parseJsonLine(stderr) || parseJsonLine(stdout) || {};
      const attempted = detail.deliveryStage === "SEND_ATTEMPTED" || detail.code === "DELIVERY_UNCONFIRMED";
        finish(errorResponse(detail.code || (signal ? "RUNTIME_TERMINATED" : "BRIDGE_COMMAND_FAILED"),
        detail.reason || detail.message || stderr.trim() || `bridge exited with status ${status}`, {
          deliveryStage: detail.deliveryStage || (attempted ? "SEND_ATTEMPTED" : "PRE_SEND"),
          sendAttempted: attempted,
          localProcess: signal ? "terminated" : "exited",
          remoteGeneration: "unknown",
          status,
          signal,
          retryAfterSec: detail.retryAfterSec,
        }));
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(errorResponse("RUNTIME_TIMEOUT", "bridge command timed out", {sendAttempted: args[0] === "send", deliveryStage: args[0] === "send" ? "SEND_ATTEMPTED" : "PRE_SEND", localProcess: "terminated", remoteGeneration: "unknown"}));
    }, timeoutMs);
  });
}

function unsupported(capability) {
  return errorResponse("UNSUPPORTED", `${capability} is not exposed by the runtime facade`, {capability, transport: "cli-subprocess"});
}

export function createRuntime({bin = new URL("../bin/chat-bridge", import.meta.url).pathname, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  const runCommand = (args) => run(bin, args, {env: {...env}, timeoutMs});

  async function probe(input = {}) {
    const capability = input?.capability;
    if (capability === "stream") return {ok: true, capability, supported: false, transport: "cli-subprocess", reason: "NO_INCREMENTAL_TRANSPORT"};
    if (capability === "ask") return {ok: true, capability, supported: true, transport: "cli-subprocess", mode: "final-only"};
    if (capability === "imageParts") return {ok: true, capability, supported: false, transport: "cli-subprocess", reason: "NO_SAFE_LOCAL_IMAGE_UPLOAD"};
    if (capability === "toolResults") return {ok: true, capability, supported: false, transport: "cli-subprocess", reason: "NO_NATIVE_TOOL_EVENT_TRANSPORT"};
    if (capability && !["resolveRoute", "send", "read", "status", "stop", "ask", "attach", "stream", "imageParts", "toolResults", "multimodal"].includes(capability)) return errorResponse("UNKNOWN_CAPABILITY", `unknown capability: ${capability}`, {capability});
    return {ok: true, capabilities: {resolveRoute: true, send: true, read: true, status: true, stop: true, ask: true, attach: true, stream: false, imageParts: false, toolResults: false, multimodal: false}, transport: "cli-subprocess"};
  }

  async function sendParts(input = {}) {
    try {
      input ||= {};
      if (!Array.isArray(input.parts) || input.parts.length === 0) return errorResponse("INVALID_INPUT", "parts must be a non-empty array");
      const images = input.parts.filter((part) => part?.type === "image");
      if (!images.length) return errorResponse("INVALID_INPUT", "parts must include an image part");
      if (images.some((part) => typeof part.url === "string")) return errorResponse("IMAGE_REMOTE_URL_FORBIDDEN", "remote image URLs are not fetched by ChatBridge", {capability: "imageParts"});
      if (images.some((part) => typeof part.data === "string" || typeof part.base64 === "string")) return errorResponse("IMAGE_DATA_FORBIDDEN", "base64 image data is not placed into a prompt", {capability: "imageParts"});
      return errorResponse("UNSUPPORTED", "native local image upload is not exposed by the current Ego Browser path", {capability: "imageParts", transport: "cli-subprocess", reason: "NO_SAFE_LOCAL_IMAGE_UPLOAD"});
    } catch (error) { return errorResponse("INVALID_INPUT", error.message); }
  }

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
      if (command === "send" || command === "ask") {
        const message = text(input.message, "message", {required: true, max: 100_000});
        if (message.startsWith("--")) return errorResponse("INVALID_INPUT", "message cannot start with --");
        args.push(message);
      }
      if (command === "ask" && input.timeout != null) {
        const timeout = Number(input.timeout);
        if (!Number.isFinite(timeout) || timeout < 1 || timeout > 600_000) return errorResponse("INVALID_INPUT", "timeout must be between 1 and 600000 milliseconds");
        args.push("--timeout", String(Math.trunc(timeout)));
      }
      args.push(...baseArgs(input));
      if (input.background === true) args.push("--background");
      const response = await runCommand(args);
      if (command === "stop" && response.ok) return {...response, cancellation: {localProcess: "exited", remoteGeneration: "unknown", receipt: "remote-stop-request-completed"}};
      if (command === "ask" && response.ok) return {...response, mode: "final-only"};
      return response;
    } catch (error) { return errorResponse("INVALID_INPUT", error.message); }
  }

  return Object.freeze({
    capabilities: Object.freeze({resolveRoute: true, send: true, read: true, status: true, stop: true, ask: true, attach: true, stream: false, imageParts: false, toolResults: false, multimodal: false}),
    probe,
    resolveRoute,
    send: (input) => session("send", input),
    read: (input) => session("read", input),
    status: (input) => session("status", input),
    stop: (input) => session("stop", input),
    ask: (input) => session("ask", input),
    attach: (input) => session("status", {...input, background: true}),
    sendParts,
    submitToolResult: async () => unsupported("toolResults"),
    stream: async () => unsupported("stream"),
    toolResults: async () => unsupported("toolResults"),
    multimodal: async () => unsupported("multimodal"),
  });
}

export {createTurnEventStream, createToolResultStream};
export const runtime = createRuntime();
