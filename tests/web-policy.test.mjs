import test from "node:test";
import assert from "node:assert/strict";
import "../src/web-policy.js";

const { isRateLimitText, findRateLimitText, cooldownSeconds, nextCooldown } = globalThis.__CHAT_BRIDGE_WEB_POLICY__;

test("detects ChatGPT conversation access rate-limit text", () => {
  assert.equal(isRateLimitText("Too many requests"), true);
  assert.equal(isRateLimitText("We’ve temporarily limited access to your conversations to protect your data."), true);
  assert.equal(isRateLimitText("Please wait a few minutes before trying again."), true);
  assert.equal(isRateLimitText("Connection interrupted"), false);
});

test("finds rate-limit text in dialog, alert, or body candidates", () => {
  assert.equal(findRateLimitText([
    "normal conversation content",
    "You’re making requests too quickly. Too many requests.",
  ]), "You’re making requests too quickly. Too many requests.");
  assert.equal(findRateLimitText(["Connection interrupted", "Try again"]), null);
});

test("cooldown escalates from 3m to 15m", () => {
  assert.equal(cooldownSeconds(1), 180);
  assert.equal(cooldownSeconds(2), 300);
  assert.equal(cooldownSeconds(3), 600);
  assert.equal(cooldownSeconds(4), 900);
  assert.equal(cooldownSeconds(20), 900);
});

test("repeated detection within an hour increments strikes", () => {
  const t0 = Date.parse("2026-09-23T09:00:00Z");
  const a = nextCooldown({}, t0, "sync", "Too many requests");
  const b = nextCooldown(a, t0 + 10 * 60 * 1000, "status", "Too many requests");
  assert.equal(a.strikes, 1);
  assert.equal(a.seconds, 180);
  assert.equal(a.active, true);
  assert.equal(a.reason, "CHATGPT_RATE_LIMIT");
  assert.equal(b.strikes, 2);
  assert.equal(b.seconds, 300);
});

test("old rate limit resets strike count", () => {
  const t0 = Date.parse("2026-09-23T09:00:00Z");
  const old = nextCooldown({}, t0, "sync", "Too many requests");
  const fresh = nextCooldown(old, t0 + 2 * 60 * 60 * 1000, "status", "Too many requests");
  assert.equal(fresh.strikes, 1);
  assert.equal(fresh.seconds, 180);
});
