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
    const exact = clean(task.replyToSessionRef) || clean(task.controllerSessionRef);
    if (exact) return [exact];
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
  function resolveControllerTarget(chats, target, project, account = null) {
    const key = clean(target);
    const active = (chat) => chat && chat.status !== "deleted" && chat.status !== "retired" && chat.project === project;
    const direct = chats[key];
    if (direct && direct.status !== "deleted" && direct.status !== "retired") return direct;
    const matches = Object.values(chats).filter(chat => active(chat) && (!account || chat.account === account) &&
      [chat.role, chat.name, chat.alias, chat.title].includes(key));
    if (matches.length === 1) return matches[0];
    throw new Error(`${matches.length ? "AMBIGUOUS_CONTROLLER" : "UNKNOWN_CONTROLLER"}: ${key}`);
  }

  globalObject.__CHAT_BRIDGE_CONTROL__ = {
    cleanControlRole: clean,
    controlRoute,
    notificationTargets,
    resolveControllerTarget,
  };
})(globalThis);
