(function installPagePool(globalObject) {
  function taskActive(status = "") {
    return !["COMPLETE", "FAILED", "CANCELLED", "BLOCKED"]
      .includes(String(status).toUpperCase());
  }

  function pageDetachCandidates(chats = [], tasks = [], options = {}) {
    const project = options.project || null;
    const account = options.account || null;
    const controlPage = options.controlPage || null;
    const excludedIds = new Set(options.excludeChatIds || []);
    const excludedPages = new Set(options.excludePageLabels || []);
    const activeTasks = (tasks || []).filter((task) =>
      taskActive(task?.status) &&
      (!project || task?.project === project) &&
      (!account || !task?.account || task?.account === account)
    );

    return (chats || [])
      .filter((chat) => {
        if (!chat || chat.status !== "active" || !chat.page) return false;
        if (project && chat.project !== project) return false;
        if (account && chat.account !== account) return false;
        if (excludedIds.has(chat.id)) return false;
        if (chat.page === controlPage || excludedPages.has(chat.page)) return false;

        const ownsActiveTask = activeTasks.some((task) =>
          task.sessionId === chat.id ||
          (!task.sessionId && task.role && task.role === chat.role)
        );
        return !ownsActiveTask;
      })
      .sort((a, b) => {
        const av = String(a.lastUsedAt || a.createdAt || "");
        const bv = String(b.lastUsedAt || b.createdAt || "");
        if (av !== bv) return av.localeCompare(bv);
        return String(a.id || "").localeCompare(String(b.id || ""));
      });
  }

  function orphanManagedPageCandidates(managedPages = [], tabs = [], options = {}) {
    if (options.hasLiveTasks) return [];
    const protectedPages = new Set(options.protectedPageLabels || []);
    const tabByLabel = new Map((tabs || []).filter(tab => tab?.label).map(tab => [tab.label, tab]));
    return (managedPages || []).filter(page => {
      const label = page?.label;
      if (!label || protectedPages.has(label)) return false;
      const tab = tabByLabel.get(label);
      if (!tab || tab.active) return false;
      return tab.openedBy === "agent";
    });
  }

  globalObject.__CHAT_BRIDGE_PAGE_POOL__ = {
    pageDetachCandidates,
    orphanManagedPageCandidates,
    taskActive,
  };
})(globalThis);
