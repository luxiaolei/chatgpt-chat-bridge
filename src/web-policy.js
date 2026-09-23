(function installWebPolicy(globalObject) {
  function normalizeText(value = "") {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isRateLimitText(value = "") {
    const text = normalizeText(value);
    return text.includes("too many requests") ||
      text.includes("temporarily limited access to your conversations") ||
      text.includes("please wait a few minutes before trying again");
  }

  function findRateLimitText(values = []) {
    return (values || []).map(value => String(value || "")).find(isRateLimitText) || null;
  }

  function cooldownSeconds(strikes = 1) {
    const n = Math.max(1, Number(strikes) || 1);
    if (n <= 1) return 180;
    if (n === 2) return 300;
    if (n === 3) return 600;
    return 900;
  }

  function nextCooldown(existing = {}, nowMs = Date.now(), context = null, detail = null) {
    const last = existing?.detectedAt ? Date.parse(existing.detectedAt) : 0;
    const withinHour = Number.isFinite(last) && last > 0 && (nowMs - last) < 60 * 60 * 1000;
    const strikes = withinHour ? Math.max(0, Number(existing.strikes) || 0) + 1 : 1;
    const seconds = cooldownSeconds(strikes);
    const detectedAt = new Date(nowMs).toISOString();
    const until = new Date(nowMs + seconds * 1000).toISOString();
    return { active: true, reason: "CHATGPT_RATE_LIMIT", strikes, seconds, detectedAt, until, context: context || null, detail: detail || null };
  }

  globalObject.__CHAT_BRIDGE_WEB_POLICY__ = {
    normalizeText,
    isRateLimitText,
    findRateLimitText,
    cooldownSeconds,
    nextCooldown,
  };
})(globalThis);
