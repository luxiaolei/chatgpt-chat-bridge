(function installModelPolicy(globalObject) {
  function modelPreset(spec) {
    const raw = String(spec ?? "").trim();
    const latest = /^(?:(?:GPT[- ]?)?6|Latest)?(?:\s+(Pro))?$/i.exec(raw);
    if (latest) return { radio: "Latest", effort: latest[1] ? "Pro" : null, label: "Latest" };
    const version = /^(?:GPT[- ]?)?(5\.[56])(?:\s+(Pro))?$/i.exec(raw);
    if (version) {
      const radio = `GPT-${version[1]}`;
      return { radio, effort: version[2] ? "Pro" : null, label: radio };
    }
    return { radio: raw, effort: null, label: raw };
  }

  function observedModel(mode) {
    const raw = String(mode ?? "");
    const text = raw.trim().replace(/\s+/g, " ");
    const effort = /(?:^|\s)(Extra High|Instant|Medium|High|Pro)$/i.exec(text);
    const modelText = effort ? text.slice(0, effort.index).trim() : text;
    const model = /^(?:GPT[- ]?)?(\d+(?:\.\d+)*)(?:\s+(Sol|Terra))?$/i.exec(modelText);
    return {
      model: model ? `GPT-${model[1]}${model[2] ? ` ${model[2][0].toUpperCase()}${model[2].slice(1).toLowerCase()}` : ""}` : null,
      effort: effort ? effort[1].toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()) : null,
      raw,
    };
  }

  function selectModelLabel(availableLabels, requestedRadio) {
    const labels = [...new Set(availableLabels)];
    if (labels.includes(requestedRadio)) return requestedRadio;
    const normalize = (label) => label.trim().replace(/\s+/g, " ").toLowerCase().replace(/^gpt[- ]?(?=\d)/, "");
    const requested = normalize(requestedRadio);
    let matches = labels.filter((label) => normalize(label) === requested);
    if (!matches.length && /^\d+(?:\.\d+)*$/.test(requested)) {
      matches = labels.filter((label) => normalize(label).startsWith(`${requested} `));
    }
    if (matches.length === 1) return matches[0];
    throw new Error(`${matches.length ? "Ambiguous" : "Unavailable"} model selection: ${requestedRadio}`);
  }

  globalObject.__CHAT_BRIDGE_MODEL_POLICY__ = { modelPreset, observedModel, selectModelLabel };
})(globalThis);
