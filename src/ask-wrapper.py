#!/usr/bin/env python3
"""Synchronous ask without holding the account UI lease while the model thinks."""
import json
import os
import subprocess
import sys
import time


def parse_json(stdout, stderr):
    for stream in (stdout or "", stderr or ""):
        text=stream.strip()
        if not text:
            continue
        for candidate in [text,*reversed([line.strip() for line in text.splitlines() if line.strip()])]:
            try:
                value=json.loads(candidate)
            except ValueError:
                continue
            if isinstance(value,dict):
                return value
    return None


def invoke(bridge,args,deadline):
    remaining=max(1,deadline-time.time())
    return subprocess.run([bridge,*args],capture_output=True,text=True,timeout=min(30,remaining),env=os.environ.copy())


def deferred(completed):
    value=parse_json(completed.stdout,completed.stderr) or {}
    if completed.returncode==75 and value.get("code") in {"PACING_DEFERRED","WEB_COOLDOWN_ACTIVE"}:
        return max(1,float(value.get("retryAfterSec",1))),value
    return None,value


def main():
    bridge,*raw=sys.argv[1:]
    if not raw:
        raise ValueError("ask requires target and message")
    target=raw[0]
    body=[]
    options=[]
    i=1
    while i<len(raw):
        item=raw[i]
        if item.startswith("--"):
            options=raw[i:]
            break
        body.append(item);i+=1
    message=" ".join(body).strip()
    if not message:
        raise ValueError("ask requires message")
    timeout_ms=180000
    if "--timeout" in options:
        j=options.index("--timeout")
        if j+1>=len(options):
            raise ValueError("--timeout requires value")
        timeout_ms=max(1000,int(options[j+1]))
        del options[j:j+2]
    deadline=time.time()+timeout_ms/1000

    before_call=invoke(bridge,["status",target,*options],deadline)
    if before_call.returncode:
        raise RuntimeError(before_call.stderr.strip() or "initial status failed")
    before=parse_json(before_call.stdout,before_call.stderr) or {}

    while True:
        sent=invoke(bridge,["send",target,message,*options],deadline)
        wait,detail=deferred(sent)
        if wait is None:
            if sent.returncode:
                raise RuntimeError(sent.stderr.strip() or "send failed")
            send_receipt=parse_json(sent.stdout,sent.stderr) or {}
            break
        if time.time()+wait>=deadline:
            raise TimeoutError("ask timed out before send")
        time.sleep(wait)

    baseline_id=before.get("lastAssistantId")
    baseline_count=int(before.get("assistantCount") or 0)
    baseline_text=before.get("lastAssistant")
    while time.time()<deadline:
        status_call=invoke(bridge,["status",target,*options],deadline)
        wait,detail=deferred(status_call)
        if wait is not None:
            if time.time()+wait>=deadline:
                break
            time.sleep(wait);continue
        if status_call.returncode:
            raise RuntimeError(status_call.stderr.strip() or "status failed")
        current=parse_json(status_call.stdout,status_call.stderr) or {}
        changed=(current.get("lastAssistantId") and current.get("lastAssistantId")!=baseline_id) or                 int(current.get("assistantCount") or 0)>baseline_count or                 (current.get("lastAssistant") and current.get("lastAssistant")!=baseline_text)
        if changed and not current.get("generating"):
            print(json.dumps({
                "chat":send_receipt.get("chat") or current.get("role") or target,
                "response":current.get("lastAssistant"),
                "modelSelection":current.get("modelSelection"),
                "dispatchModel":send_receipt.get("dispatchModel"),
            },ensure_ascii=False))
            return
        time.sleep(1)
    raise TimeoutError("ask timed out waiting for a new assistant response")


if __name__=="__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"ok":False,"error":str(error)},ensure_ascii=False),file=sys.stderr)
        raise SystemExit(2)
