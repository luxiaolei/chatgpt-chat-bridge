import test from "node:test";
import assert from "node:assert/strict";
import "../src/model-policy.js";

const { modelPreset, observedModel, selectModelLabel } = globalThis.__CHAT_BRIDGE_MODEL_POLICY__;

test("default and current version aliases do not implicitly request Pro", () => {
  for (const spec of [undefined, null, "", "  ", "Latest", "GPT-6", "6"]) {
    assert.deepEqual(modelPreset(spec), { radio: "Latest", effort: null, label: "Latest" });
  }
});

test("current Pro presets keep the Latest radio label separate from version", () => {
  for (const spec of ["GPT-6 Pro", "latest pro", "6 Pro"]) {
    assert.deepEqual(modelPreset(spec), { radio: "Latest", effort: "Pro", label: "Latest" });
  }
});

test("older version Pro presets never select Latest", () => {
  for (const version of ["5.6", "5.5"]) {
    for (const prefix of ["", "GPT-"]) {
      assert.deepEqual(modelPreset(`${prefix}${version} Pro`), {
        radio: `GPT-${version}`, effort: "Pro", label: `GPT-${version}`,
      });
    }
    assert.deepEqual(modelPreset(version), { radio: `GPT-${version}`, effort: null, label: `GPT-${version}` });
  }
});

test("explicit variants and legacy model labels are preserved", () => {
  for (const spec of ["GPT-5.6 Sol", "GPT-5.5 Terra", "GPT-4o", "o3", "o4-mini", "GPT-5.6.1 Pro"]) {
    assert.deepEqual(modelPreset(spec), { radio: spec, effort: null, label: spec });
  }
});

test("exact labels win before version alias and variant matching", () => {
  const labels = ["GPT-5.6 Sol", "GPT-5.6 Terra", "5.6", "GPT-5.6"];
  for (const label of labels) assert.equal(selectModelLabel(labels, label), label);
  assert.equal(selectModelLabel(["GPT-4o", "Latest"], "GPT-4o"), "GPT-4o");
});

test("version aliases and sole version variants match the actual UI label", () => {
  assert.equal(selectModelLabel(["Latest", "5.6"], "GPT-5.6"), "5.6");
  assert.equal(selectModelLabel(["GPT-5.6"], "5.6"), "GPT-5.6");
  assert.equal(selectModelLabel(["Latest", "GPT-5.6 Sol"], "GPT-5.6"), "GPT-5.6 Sol");
  assert.equal(selectModelLabel(["5.6 Sol"], "GPT-5.6 Sol"), "5.6 Sol");
});

test("ambiguous, unavailable, patch versions and unrelated variants fail explicitly", () => {
  assert.throws(() => selectModelLabel(["GPT-5.6 Sol", "GPT-5.6 Terra"], "GPT-5.6"), /Ambiguous/);
  assert.throws(() => selectModelLabel(["5.6", "GPT-5.6"], "gpt-5.6"), /Ambiguous/);
  for (const labels of [[], ["Latest"], ["GPT-5.6.1"], ["GPT-5.6.1 Sol"], ["GPT-5.60"]]) {
    assert.throws(() => selectModelLabel(labels, "GPT-5.6"), /Unavailable/);
  }
  assert.throws(() => selectModelLabel(["GPT-5.6 Terra", "GPT-5.6"], "GPT-5.6 Sol"), /Unavailable/);
});

test("observed combined model and effort text retains original raw text", () => {
  for (const [raw, model, effort] of [
    ["6\nPro", "GPT-6", "Pro"],
    ["5.6 Sol Extra High", "GPT-5.6 Sol", "Extra High"],
    [" GPT-5.5\nHigh ", "GPT-5.5", "High"],
    ["GPT-5.6 Sol", "GPT-5.6 Sol", null],
    ["5.6.1 Medium", "GPT-5.6.1", "Medium"],
    ["6 Instant", "GPT-6", "Instant"],
    ["Latest Pro", null, "Pro"],
    ["Unknown High", null, "High"],
    ["", null, null],
  ]) assert.deepEqual(observedModel(raw), { model, effort, raw });
});
