import test from "node:test";
import assert from "node:assert/strict";
import "../src/session-policy.js";

const { recoveryRequired, contextExhausted } = globalThis.__CHAT_BRIDGE_SESSION_POLICY__;

test("normal regenerate action is not treated as an error", () => {
  assert.equal(recoveryRequired({
    recoveryControls: [{ label: "Regenerate response", disabled: false }],
    errorTexts: [],
  }), false);
});

test("real recovery controls and error text require recovery", () => {
  for (const label of ["Try again", "Retry", "Continue generating"]) {
    assert.equal(recoveryRequired({ recoveryControls: [{ label }], errorTexts: [] }), true, label);
  }
  assert.equal(recoveryRequired({ recoveryControls: [], errorTexts: ["Something went wrong"] }), true);
});

test("empty healthy idle snapshot does not require recovery", () => {
  assert.equal(recoveryRequired({ recoveryControls: [], errorTexts: [] }), false);
});


test("hard context limit is terminal for recovery and requires rotation", () => {
  for (const text of [
    "This conversation has reached the maximum length.",
    "Maximum context length exceeded.",
    "The context is too long for this conversation."
  ]) {
    const raw={recoveryControls:[{label:"Try again"}],errorTexts:[text]};
    assert.equal(contextExhausted(raw),true,text);
    assert.equal(recoveryRequired(raw),false,text);
  }
});
