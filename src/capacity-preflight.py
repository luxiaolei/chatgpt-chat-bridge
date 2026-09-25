#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, pathlib, re, sys, time

TERMINAL = {'COMPLETE','FAILED','CANCELLED','BLOCKED'}

def read_json(path, default):
    try: return json.loads(path.read_text())
    except Exception: return default

def scope(reg, account):
    identity=(reg.get('accounts',{}).get(account) or {}).get('identity')
    raw=f'identity:{identity}' if identity else f'alias:{account}'
    return hashlib.sha256(raw.encode()).hexdigest()

def cooldown(state, reg, account, now):
    p=state/'web-cooldowns'/(scope(reg,account)+'.json')
    value=read_json(p,{})
    until=value.get('until')
    try: active=bool(until and time.mktime(time.strptime(until[:19],'%Y-%m-%dT%H:%M:%S')) > now)
    except Exception:
        try:
            from datetime import datetime, timezone
            active=datetime.fromisoformat(str(until).replace('Z','+00:00')).timestamp()>now
        except Exception: active=False
    return {'active':active,'until':until,'strikes':value.get('strikes',0)}

def snapshot(config, state, project, now=None):
    now=time.time() if now is None else float(now)
    reg=read_json(config/'registry.json',{})
    rt=read_json(state/'runtime.json',{})
    proj=(reg.get('projects') or {}).get(project) or {}
    accounts=sorted((proj.get('bindings') or {}).keys())
    rows=[]
    for account in accounts:
        binding=(proj.get('bindings') or {}).get(account) or {}
        chats=[c for c in (reg.get('chats') or {}).values() if c.get('project')==project and c.get('account')==account and c.get('status')=='active']
        tasks=[t for t in (rt.get('tasks') or {}).values() if t.get('project')==project and (t.get('account')==account or (t.get('sessionId') and (reg.get('chats') or {}).get(t.get('sessionId'),{}).get('account')==account)) and str(t.get('status','')).upper() not in TERMINAL]
        sessions=rt.get('sessions') or {}
        running=sum(1 for c in chats if str((sessions.get(c.get('id')) or {}).get('sessionState','')).startswith('RUNNING'))
        cd=cooldown(state,reg,account,now)
        reasons=[]
        verified=bool((reg.get('accounts',{}).get(account) or {}).get('identity'))
        if not binding: reasons.append('BINDING_MISSING')
        if not binding.get('spaceName'): reasons.append('SPACE_MISSING')
        if not verified: reasons.append('IDENTITY_UNVERIFIED')
        if cd['active']: reasons.append('WEB_COOLDOWN')
        stamp=state/f'ui-pacing-{scope(reg,account)}.last'
        try: last_ui=float(stamp.read_text().strip())
        except Exception: last_ui=None
        rows.append({
          'account':account,
          'identityVerified':verified,
          'spaceName':binding.get('spaceName'),
          'spaceId':binding.get('spaceId'),
          'cooldown':cd,
          'activeTasks':len(tasks),
          'activeChats':len(chats),
          'attachedPages':sum(1 for c in chats if c.get('page')),
          'runningSessions':running,
          'lastUiAt':last_ui,
          'eligible':not reasons,
          'exclusionReasons':reasons,
        })
    return {'schema':'chat-bridge.capacity.v1','project':project,'activeAccount':proj.get('activeAccount'),'accounts':rows}

def affinity_accounts(config, state, project, key):
    if not key: return []
    reg=read_json(config/'registry.json',{})
    rt=read_json(state/'runtime.json',{})
    found=set()
    for c in (reg.get('chats') or {}).values():
        if c.get('project')==project and c.get('status')=='active' and c.get('affinityKey')==key and c.get('account'): found.add(c['account'])
    for t in (rt.get('tasks') or {}).values():
        if t.get('project')==project and str(t.get('status','')).upper() not in TERMINAL and t.get('affinityKey')==key and t.get('account'): found.add(t['account'])
    return sorted(found)

def choose(config, state, project, affinity=None, explicit=None, now=None):
    snap=snapshot(config,state,project,now)
    by={x['account']:x for x in snap['accounts']}
    reason='LEAST_LOAD'
    sticky=False
    if explicit:
        if explicit not in by: raise ValueError('explicit account is not bound to project')
        selected=explicit; reason='EXPLICIT'
    else:
        sticky_accounts=affinity_accounts(config,state,project,affinity)
        if len(sticky_accounts)>1: raise ValueError('affinity key is active on multiple accounts')
        if sticky_accounts:
            selected=sticky_accounts[0]; reason='AFFINITY'; sticky=True
        else:
            eligible=[x for x in snap['accounts'] if x['eligible']]
            if not eligible: raise RuntimeError('no eligible ChatGPT account binding')
            selected=min(eligible,key=lambda x:(x['activeTasks'],x['attachedPages'],x['activeChats'],x['account']))['account']
    row=by[selected]
    if not row['eligible']:
        raise RuntimeError('selected sticky/explicit account is not currently eligible: '+','.join(row['exclusionReasons']))
    return {'schema':'chat-bridge.account-selection.v1','project':project,'selectedAccount':selected,'reason':reason,'sticky':sticky,'affinityKey':affinity,'candidate':row,'capacity':snap['accounts']}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('mode',choices=['capacity','select'])
    ap.add_argument('config_dir'); ap.add_argument('state_dir')
    ap.add_argument('--project',required=True); ap.add_argument('--affinity-key'); ap.add_argument('--account')
    ns=ap.parse_args(); config=pathlib.Path(ns.config_dir); state=pathlib.Path(ns.state_dir)
    try: out=snapshot(config,state,ns.project) if ns.mode=='capacity' else choose(config,state,ns.project,ns.affinity_key,ns.account)
    except Exception as exc:
        print(json.dumps({'ok':False,'error':str(exc)},ensure_ascii=False),file=sys.stderr); return 2
    print(json.dumps(out,ensure_ascii=False,indent=2)); return 0

if __name__=='__main__': raise SystemExit(main())
