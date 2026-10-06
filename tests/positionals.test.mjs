import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import path from "node:path";

const source=await readFile(path.resolve("src/main.js"),"utf8");
const code=source.slice(source.indexOf("function positionals("),source.indexOf("\nfunction convId("));
const parse=argv=>new Function("args",code+";return positionals(2);")(argv);
const body="原正文\n字面量 Latest 与 --background 保留\n";

test("the real World05 option order preserves the exact message before a model option",()=>{
  assert.deepEqual(parse(["send","worker",body,"--project","AGI Game","--account","hzcodex","--background","--model","Latest","--effort","Extra High"]),[body]);
});

test("every supported boolean may precede valued flags without consuming them",()=>{
  const flags=[...new Set([...source.matchAll(/args\.includes\("(--[^"\n]+)"/g)].map(m=>m[1]))].filter(flag=>flag!=="--project"); // Valued option presence is not a boolean flag.
  for(const command of ["send","ask","stream","model","effort"]) for(const flag of flags)
    assert.deepEqual(parse([command,"worker",body,flag,"--project","P","--account","a"]),[body],`${command}:${flag}`);
});

test("malformed or unknown option shapes fail instead of becoming message text",()=>{
  for(const options of [["--unknown","value"],["--model"],["--model","--background"],["--model=Latest"]])
    assert.throws(()=>parse(["send","worker",body,...options]),/option/i);
});

test("all runtime value options consume exactly one value",()=>{
  for(const flag of new Set([...source.matchAll(/\bopt\("([^"\n]+)"/g)].map(m=>m[1])))
    assert.deepEqual(parse(["send","worker",body,"--"+flag,"value","--background"]),[body],flag);
});
