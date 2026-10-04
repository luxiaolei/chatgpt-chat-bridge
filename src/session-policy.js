(function installSessionPolicy(globalObject) {
  function contextExhausted(raw = {}) {
    // Instructions and quoted assistant prose are not platform error UI.
    const text = (raw.errorTexts || []).join(" ");
    return /(context.{0,30}(?:too long|length|window|maximum)|maximum.{0,30}(?:context|conversation)|conversation.{0,30}(?:too long|maximum|limit)|reached.{0,30}maximum.{0,30}(?:conversation|context))/i.test(text);
  }

  function recoveryRequired(raw = {}) {
    if (raw.approvalRequired === true || contextExhausted(raw)) return false;
    if (Array.isArray(raw.errorTexts) && raw.errorTexts.length) return true;
    return (raw.recoveryControls || []).some((control) => {
      if (control?.disabled || control?.historical) return false;
      const label = String(control?.label || "").trim().toLowerCase();
      if (!label) return false;
      if (label === "regenerate response" || label === "regenerate") return false;
      return ["continue generating", "try again", "retry"].some((token) => label.includes(token));
    });
  }

  function sameConversationUrl(actual, expected) {
    try {
      const a = new URL(actual), b = new URL(expected);
      if (a.origin !== "https://chatgpt.com" || b.origin !== a.origin || a.username || b.username || a.password || b.password) return false;
      const conversation = url => /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(url.pathname)?.[1]?.toLowerCase();
      const project = url => /\/g\/(g-p-[0-9a-f]{32})(?:[-/]|$)/i.exec(url.pathname)?.[1]?.toLowerCase();
      const id = conversation(a), other = conversation(b);
      return !!id && id === other && (!project(a) || !project(b) || project(a) === project(b));
    } catch { return false; }
  }
  globalObject.__CHAT_BRIDGE_SESSION_POLICY__ = { recoveryRequired, contextExhausted, sameConversationUrl };
})(globalThis);
