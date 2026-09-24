(function installTaskPolicy(globalObject) {
  function activeTaskStatus(value = "") {
    return !["COMPLETE", "FAILED", "CANCELLED", "BLOCKED"]
      .includes(String(value || "").toUpperCase());
  }

  function normalizeCompletionMode(value = "durable") {
    const mode = String(value || "durable").trim().toLowerCase();
    if (!["durable", "external"].includes(mode)) {
      throw new Error("completion mode must be durable or external");
    }
    return mode;
  }

  function assertTaskId(value) {
    const taskId = value == null ? "" : String(value).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(taskId)) {
      throw new Error("task id must be a stable non-option token");
    }
    return taskId;
  }

  function assertActiveTaskTarget(task = {}) {
    if (!activeTaskStatus(task.status)) return task;
    if (!task.sessionId && !task.role) {
      throw new Error("active task requires role or session target");
    }
    return task;
  }

  function activeSessionConflict(tasks = [], candidate = {}) {
    if (!activeTaskStatus(candidate.status) || !candidate.sessionId) return null;
    return (tasks || []).find((task) =>
      task &&
      task.taskId !== candidate.taskId &&
      activeTaskStatus(task.status) &&
      task.project === candidate.project &&
      (!candidate.account || !task.account || task.account === candidate.account) &&
      task.sessionId === candidate.sessionId
    ) || null;
  }

  globalObject.__CHAT_BRIDGE_TASK_POLICY__ = {
    activeTaskStatus,
    normalizeCompletionMode,
    assertTaskId,
    assertActiveTaskTarget,
    activeSessionConflict,
  };
})(globalThis);
