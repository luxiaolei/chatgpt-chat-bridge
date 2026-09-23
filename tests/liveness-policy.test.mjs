import test from "node:test";
import assert from "node:assert/strict";
import "../src/liveness-policy.js";

const { normalizeModeText, stallThresholdSec } = globalThis.__CHAT_BRIDGE_LIVENESS__;

test("normalizes composite model and effort text", () => {
  assert.equal(normalizeModeText("6\nPro"), "6 pro");
  assert.equal(normalizeModeText("GPT-5.6 Sol\nExtra High"), "gpt 5.6 sol extra high");
});

test("Pro composite strings map to 900 seconds", () => {
  for (const value of ["Pro", "6\nPro", "GPT-6 Pro", "Latest  Pro"]) {
    assert.equal(stallThresholdSec(value), 900, value);
  }
});

test("Extra High composite strings map to 720 seconds before High", () => {
  for (const value of ["Extra High", "GPT-5.6 Sol\nExtra High", "Sol Extra-High"]) {
    assert.equal(stallThresholdSec(value), 720, value);
  }
});

test("High and Medium retain their thresholds", () => {
  assert.equal(stallThresholdSec("GPT-5.6 Sol High"), 480);
  assert.equal(stallThresholdSec("Medium"), 300);
});

test("unknown or blank mode keeps conservative default", () => {
  assert.equal(stallThresholdSec(""), 240);
  assert.equal(stallThresholdSec("Instant"), 240);
  assert.equal(stallThresholdSec("unrecognized"), 240);
});
