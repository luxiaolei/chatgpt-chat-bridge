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
      draftPolicy: raw.draftPolicy === "discard" ? "discard" : "preserve",
      maxOverflowSpaces: raw.maxOverflowSpaces === 2 ? 2 : 1,
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

  function groupProgressTask(task = {}) {
    return durableProgressTask(task) ||
      (String(task.status || "").toUpperCase() === "RESULT_RECORDED" &&
       !!clean(task.resultVersion) && !!clean(task.resultRecordedAt || task.updatedAt));
  }

  function taskWorkgroupId(task = {}) {
    return clean(task.workgroupId || task.workgroup || task.scope?.workgroupId);
  }

  function reconcileCandidate(projectName, project = {}, tasks = [], runtimeProject = {}, nowMs = Date.now(), scope = null) {
    const policy = normalizeLifecycle(project);
    if (!policy.autoReconcile) return null;
    const workgroupId = typeof scope === "string" ? clean(scope) : clean(scope?.workgroupId);
    const legacyOnly = !!(scope && typeof scope === "object" && scope.legacyOnly);
    const groupScoped = !!workgroupId;
    const projectTasks = (tasks || []).filter(t => t && t.project === projectName &&
      (groupScoped ? taskWorkgroupId(t) === workgroupId : (legacyOnly ? !taskWorkgroupId(t) : true)));
    // RESULT_RECORDED releases the worker slot; its callback/ACK remains durable
    // state and is reported separately while the controller schedules review.
    const settled = task => isTerminal(task) || String(task.status || "").toUpperCase() === "RESULT_RECORDED";
    const activeDomain = projectTasks.filter(t => !settled(t) &&
      (groupScoped ? true : !isRootTask(t, policy.reconcileRole)));
    if (activeDomain.length) return null;
    const durable = projectTasks.filter(groupProgressTask)
      .sort((a, b) => String(b.resultRecordedAt || b.updatedAt).localeCompare(String(a.resultRecordedAt || a.updatedAt)))[0];
    if (!durable) return null;
    const progressAt = String(durable.resultRecordedAt || durable.updatedAt);
    const eventVersion = clean(durable.resultVersion || durable.resultEventId);
    const lastProgress = runtimeProject.lastReconcileProgressAt;
    const lastVersion = clean(runtimeProject.lastReconcileResultVersion);
    if (lastProgress && progressAt < String(lastProgress)) return null;
    if (lastProgress && progressAt === String(lastProgress) && (!eventVersion || eventVersion === lastVersion)) return null;
    const last = Date.parse(runtimeProject.lastReconcileNotifiedAt || "");
    const waitSec = Number.isFinite(last)
      ? Math.max(0, policy.minGapSec - (nowMs - last) / 1000)
      : 0;
    return {
      event: "RECONCILE_REQUIRED",
      reason: "DOMAIN_IDLE_WITH_DURABLE_PROGRESS",
      project: projectName,
      ...(groupScoped ? {workgroupId, ownerSessionRef: clean(scope?.ownerSessionRef)} : {}),
      ...(!groupScoped && clean(durable.replyToSessionRef || durable.controllerSessionRef)
        ? {ownerSessionRef: clean(durable.replyToSessionRef || durable.controllerSessionRef)} : {}),
      rootRole: policy.reconcileRole,
      latestTaskId: durable.taskId || null,
      latestGithub: durable.github || null,
      progressAt,
      ...(eventVersion ? {resultVersion: eventVersion} : {}),
      eventKey: groupScoped
        ? [projectName, workgroupId, durable.taskId || "", eventVersion || progressAt].join(":")
        : [projectName, durable.taskId || "", eventVersion || progressAt].join(":"),
      ready: waitSec <= 0,
      waitSec,
      instruction: policy.instruction,
    };
  }

  function reconcileCandidates(projectName, project = {}, tasks = [], runtimeProject = {}, nowMs = Date.now()) {
    const groups = Object.entries(project.workgroups || {});
    if (!groups.length) return [reconcileCandidate(projectName, project, tasks, runtimeProject, nowMs)].filter(Boolean);
    const candidates = [];
    for (const [workgroupId, group] of groups) {
      const scopedRuntime = (runtimeProject.workgroups || {})[workgroupId] || {};
      const candidate = reconcileCandidate(projectName, project, tasks, scopedRuntime, nowMs, {
        workgroupId,
        ownerSessionRef: group.controllerSessionRef || group.ownerSessionRef,
      });
      if (candidate) candidates.push(candidate);
    }
    const legacy = reconcileCandidate(projectName, project, tasks, runtimeProject, nowMs, { legacyOnly: true });
    if (legacy) candidates.push(legacy);
    return candidates;
  }

  globalObject.__CHAT_BRIDGE_LIFECYCLE_POLICY__ = {
    normalizeLifecycle,
    reconcileCandidate,
    reconcileCandidates,
    isTerminal,
    isRootTask,
    durableProgressTask,
    taskWorkgroupId,
  };
})(globalThis);
