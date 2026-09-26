const topologyCrypto = await import("node:crypto");
(function installTopology(globalObject) {
  function topologyPreview(reg, runtime = {}) {
    const accounts = new Map();
    const byAlias = new Map();
    for (const [alias, record] of Object.entries(reg.accounts || {})) {
      const key = record.identity ? `identity:${record.identity}` : `unverified:${alias}`;
      const current = accounts.get(key) || { accountId: record.identity ? topologyCrypto.createHash("sha256").update(key).digest("hex") : null,
        name: record.label || alias, aliases: [], verified: !!record.identity };
      current.aliases.push(alias);
      accounts.set(key, current);
      byAlias.set(alias, key);
    }
    for (const space of Object.values(reg.spaces || {})) {
      const account = space.identity && accounts.get(`identity:${space.identity}`);
      if (account && space.accountName) account.name = space.accountName;
    }
    const projects = Object.entries(reg.projects || {}).map(([key, record]) => {
      const locations = new Map();
      for (const [alias, binding] of Object.entries(record.bindings || {})) {
        const accountKey = byAlias.get(alias) || `unverified:${alias}`;
        const locationKey = `${accountKey}:${binding.projectId || binding.projectUrl || alias}`;
        const location = locations.get(locationKey) || { accountAliases: [], accountName: accounts.get(accountKey)?.name || alias,
          projectId: binding.projectId || null, projectUrl: binding.projectUrl || null, spaces: [] };
        location.accountAliases.push(alias);
        if (binding.spaceName && !location.spaces.includes(binding.spaceName)) location.spaces.push(binding.spaceName);
        locations.set(locationKey, location);
      }
      return { businessProjectId: record.businessProjectId || key, name: record.name || key,
        allowedAccounts: record.allowedAccounts || Object.keys(record.bindings || {}),
        workgroups: Object.entries(record.workgroups || {}).map(([id, group]) => ({ id, name: group.name || id,
          controllerSessionRef: group.controllerSessionRef || null })),
        locations: [...locations.values()],
        sessions: Object.values(reg.chats || {}).filter(chat => chat.project === key).map(chat => ({
          sessionRef: chat.id, accountAlias: chat.account, role: chat.role || null, status: chat.status || 'active',
        })) };
    });
    return { accounts: [...accounts.values()], projects, taskCount: Object.keys(runtime.tasks || {}).length,
      unresolvedSpaces: Object.values(reg.spaces || {}).filter(space => !space.ownership).map(space => space.name) };
  }
  globalObject.__CHAT_BRIDGE_TOPOLOGY__ = { topologyPreview };
})(globalThis);
