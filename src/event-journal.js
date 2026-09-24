(function installEventJournal(globalObject) {
  function safeSegment(value, fallback="default") {
    const text=String(value||"").trim();
    if(!text) return fallback;
    return text.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g,"_").replace(/^_+|_+$/g,"").slice(0,96)||fallback;
  }

  async function acquireLock(fs, lockDir, timeoutMs=2000) {
    const started=Date.now();
    while(true) {
      try {
        await fs.mkdir(lockDir);
        await fs.writeFile((await import("node:path")).join(lockDir,"pid"),String(process.pid),"utf8");
        return;
      } catch(error) {
        if(error?.code!=="EEXIST") throw error;
        try {
          const path=await import("node:path");
          const owner=Number((await fs.readFile(path.join(lockDir,"pid"),"utf8")).trim());
          if(Number.isInteger(owner)&&owner>0) {
            try { process.kill(owner,0); }
            catch(check) {
              if(check?.code==="ESRCH") { await fs.rm(lockDir,{recursive:true,force:true}); continue; }
            }
          }
        } catch {}
        if(Date.now()-started>=timeoutMs) throw new Error("event journal lock busy");
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
  }

  async function appendEvent(stateDir, event) {
    if(!event || typeof event!=="object") throw new Error("event object required");
    const project=String(event.project||"").trim();
    const account=String(event.account||"").trim();
    const type=String(event.type||"").trim();
    if(!project||!account||!/^[A-Z][A-Z0-9_]{2,63}$/.test(type)) {
      throw new Error("event requires project/account and stable uppercase type");
    }
    const fs=await import("node:fs/promises");
    const path=await import("node:path");
    const crypto=await import("node:crypto");
    const dir=path.join(stateDir,"events",safeSegment(project));
    const file=path.join(dir,safeSegment(account)+".jsonl");
    const lock=file+".lock";
    await fs.mkdir(dir,{recursive:true});
    await acquireLock(fs,lock);
    try {
      const cursor=`${Date.now().toString(36)}-${process.pid.toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
      const record={
        schema:"chat-bridge.event.v1",
        cursor,
        at:new Date().toISOString(),
        project,
        account,
        type,
        taskId:event.taskId||null,
        role:event.role||null,
        sessionId:event.sessionId||null,
        controller:event.controller||null,
        replyTo:event.replyTo||null,
        escalationTo:event.escalationTo||null,
        rootController:event.rootController||null,
        data:event.data&&typeof event.data==="object"?event.data:{},
      };
      const line=JSON.stringify(record);
      if(Buffer.byteLength(line,"utf8")>262144) throw new Error("event payload exceeds 256 KiB");
      await fs.appendFile(file,line+"\n",{encoding:"utf8",mode:0o600});
      try { await fs.chmod(file,0o600); } catch {}
      return record;
    } finally {
      await fs.rm(lock,{recursive:true,force:true});
    }
  }

  async function listEvents(stateDir, options={}) {
    const project=String(options.project||"").trim();
    const account=String(options.account||"").trim();
    if(!project||!account) throw new Error("project and account required");
    const fs=await import("node:fs/promises");
    const path=await import("node:path");
    const file=path.join(stateDir,"events",safeSegment(project),safeSegment(account)+".jsonl");
    let raw="";
    try { raw=await fs.readFile(file,"utf8"); }
    catch(error) { if(error?.code==="ENOENT") return []; throw error; }
    const rows=raw.split(/\n/).filter(Boolean).map(line=>JSON.parse(line));
    const after=options.after?String(options.after):null;
    let start=0;
    if(after) {
      const index=rows.findIndex(row=>row.cursor===after);
      start=index>=0?index+1:0;
    }
    const type=options.type?String(options.type):null;
    const filtered=rows.slice(start).filter(row=>!type||row.type===type);
    const limit=Math.max(1,Math.min(1000,Number(options.limit||100)||100));
    return filtered.slice(0,limit);
  }

  globalObject.__CHAT_BRIDGE_EVENTS__={safeSegment,appendEvent,listEvents};
})(globalThis);
