(function installControlRouting(globalObject) {
  function clean(value) {
    const text = value == null ? "" : String(value).trim();
    return text || null;
  }

  function controlRoute(task = {}, rootController = "conductor") {
    const root = clean(rootController) || "conductor";
    const controller =
      clean(task.controller) ||
      clean(task.replyTo) ||
      clean(task.reply_to) ||
      root;
    const replyTo =
      clean(task.replyTo) ||
      clean(task.reply_to) ||
      controller;
    let escalationTo =
      clean(task.escalationTo) ||
      clean(task.escalation_to) ||
      (controller !== root ? root : null);

    if (escalationTo === controller) escalationTo = null;

    return {
      controller,
      replyTo,
      escalationTo,
      rootController: root,
    };
  }
  function notificationTargets(task = {}, rootController = "conductor") {
    const route = controlRoute(task, rootController);
    const ordered = [
      route.replyTo,
      route.controller,
      route.escalationTo,
      route.rootController,
    ];
    const seen = new Set();
    return ordered.filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }

  globalObject.__CHAT_BRIDGE_CONTROL__ = {
    cleanControlRole: clean,
    controlRoute,
    notificationTargets,
  };
})(globalThis);
