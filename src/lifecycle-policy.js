(function installLifecyclePolicy(globalObject) {
  const TERMINAL = new Set(["COMPLETE", "FAILED", "CANCELLED", "BLOCKED"]);

  function clean(value) {
    const text = value == null ? "" : String(value).trim();
    return text || null;
  }

  function normalizeLifecycle(project = {}) {
    const raw = project.lifecycle || {};
    const minGap = Number(raw.minGapSec);
    return {
      autoReconcile: raw.autoReconcile === true,
      reconcileRole: clean(raw.reconcileRole) || clean(project.rootController) || "conductor",
      minGapSec: Number.isFinite(minGap) && minGap >= 0 ? minGap : 300,
      instruction: clean(raw.instruction),
    };
  }

  function isTerminal(task = {}) {
    return TERMINAL.has(String(task.status || "").toUpperCase());
  }

  function isRootTask(task = {}, rootRole = "conductor") {
    return clean(task.role) === rootRole &&
      (!clean(task.controller) || clean(task.controller) === rootRole);
  }

  function durableProgressTask(task = {}) {
    return String(task.status || "").toUpperCase() === "COMPLETE" &&
      !!clean(task.github) && !!clean(task.updatedAt);
  }

  function reconcileCandidate(projectName, project = {}, tasks = [], runtimeProject = {}, nowMs = Date.now()) {
    const policy = normalizeLifecycle(project);
    if (!policy.autoReconcile) return null;
    const projectTasks = (tasks || []).filter(t => t && t.project === projectName);
    const activeDomain = projectTasks.filter(t => !isTerminal(t) && !isRootTask(t, policy.reconcileRole));
    if (activeDomain.length) return null;
    const durable = projectTasks.filter(durableProgressTask)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    if (!durable) return null;
    const progressAt = String(durable.updatedAt);
    if (runtimeProject.lastReconcileProgressAt &&
        progressAt <= String(runtimeProject.lastReconcileProgressAt)) return null;
    const last = Date.parse(runtimeProject.lastReconcileNotifiedAt || "");
    const waitSec = Number.isFinite(last)
      ? Math.max(0, policy.minGapSec - (nowMs - last) / 1000)
      : 0;
    return {
      event: "RECONCILE_REQUIRED",
      reason: "DOMAIN_IDLE_WITH_DURABLE_PROGRESS",
      project: projectName,
      rootRole: policy.reconcileRole,
      latestTaskId: durable.taskId || null,
      latestGithub: durable.github || null,
      progressAt,
      eventKey: [projectName, durable.taskId || "", progressAt].join(":"),
      ready: waitSec <= 0,
      waitSec,
      instruction: policy.instruction,
    };
  }

  globalObject.__CHAT_BRIDGE_LIFECYCLE_POLICY__ = {
    normalizeLifecycle,
    reconcileCandidate,
    isTerminal,
    isRootTask,
    durableProgressTask,
  };
})(globalThis);
