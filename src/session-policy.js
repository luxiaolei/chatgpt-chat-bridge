(function installSessionPolicy(globalObject) {
  function recoveryRequired(raw = {}) {
    if (Array.isArray(raw.errorTexts) && raw.errorTexts.length) return true;
    return (raw.recoveryControls || []).some((control) => {
      const label = String(control?.label || "").trim().toLowerCase();
      if (!label) return false;
      if (label === "regenerate response" || label === "regenerate") return false;
      return ["continue generating", "try again", "retry"].some((token) => label.includes(token));
    });
  }

  globalObject.__CHAT_BRIDGE_SESSION_POLICY__ = { recoveryRequired };
})(globalThis);
