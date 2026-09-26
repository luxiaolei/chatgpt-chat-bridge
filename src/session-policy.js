(function installSessionPolicy(globalObject) {
  function contextExhausted(raw = {}) {
    const text = [
      ...(raw.errorTexts || []),
      raw.lastAssistant || "",
      raw.lastUser || "",
    ].join(" ");
    return /(context.{0,30}(?:too long|length|window|maximum)|maximum.{0,30}(?:context|conversation)|conversation.{0,30}(?:too long|maximum|limit)|reached.{0,30}maximum.{0,30}(?:conversation|context))/i.test(text);
  }

  function recoveryRequired(raw = {}) {
    if (contextExhausted(raw)) return false;
    if (Array.isArray(raw.errorTexts) && raw.errorTexts.length) return true;
    return (raw.recoveryControls || []).some((control) => {
      const label = String(control?.label || "").trim().toLowerCase();
      if (!label) return false;
      if (label === "regenerate response" || label === "regenerate") return false;
      return ["continue generating", "try again", "retry"].some((token) => label.includes(token));
    });
  }

  globalObject.__CHAT_BRIDGE_SESSION_POLICY__ = { recoveryRequired, contextExhausted };
})(globalThis);
