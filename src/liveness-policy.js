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

  globalObject.__CHAT_BRIDGE_LIVENESS__ = {
    normalizeModeText,
    stallThresholdSec,
  };
})(globalThis);
