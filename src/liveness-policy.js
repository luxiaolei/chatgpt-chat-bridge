(function installLivenessPolicy(globalObject) {
  function normalizeModeText(value = "") {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[-_]/g, " ")
      .replace(/\s+/g, " ");
  }

  function stallThresholdSec(value = "") {
    const key = normalizeModeText(value);
    if (/\bpro\b/.test(key)) return 900;
    if (/\bextra high\b/.test(key)) return 720;
    if (/\bhigh\b/.test(key)) return 480;
    if (/\bmedium\b/.test(key)) return 300;
    return 240;
  }

  // Warning thresholds are not permission to cancel a model/tool turn.
  function effortName(value = "") {
    const match = /(?:^|\s)(extra high|instant|medium|high|pro)$/.exec(normalizeModeText(value));
    return match ? match[1].replace(/\b\w/g, letter => letter.toUpperCase()) : null;
  }
  function livenessBudget(raw = {}, task = null, configuredEffort = null) {
    const requestedEffort = effortName(task?.requestedEffort || configuredEffort);
    const observedEffort = effortName(raw.mode);
    const explicit = Number(task?.stallThresholdSec);
    const threshold = Number.isFinite(explicit) && explicit > 0 ? explicit : Math.max(
      stallThresholdSec(requestedEffort), stallThresholdSec(observedEffort)
    );
    return {stallThresholdSec: threshold, requestedEffort, observedEffort,
      effortMismatch: !!requestedEffort && !!observedEffort && requestedEffort !== observedEffort};
  }
  globalObject.__CHAT_BRIDGE_LIVENESS__ = {
    normalizeModeText,
    stallThresholdSec,
    effortName,
    livenessBudget,
  };
})(globalThis);
