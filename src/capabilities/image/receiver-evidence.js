/** Read-only Node child of the authenticated coordinator; no grants, DB, transport or repair. */
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as contract from './contract.js';
import {createControlledImageStore} from './exporter.js';
import {readImageConsumerReceipt} from './manifest.js';
import {sha256,safeArtifactCode} from './verifier.js';

export async function readReceiverEvidence({stateDir,bindings,at}) {
  const evidence=[];
  for (const binding of bindings) {
    let observation;
    try {
      const store=await createControlledImageStore({root:path.join(stateDir,'image-received',sha256(binding.destinationRef)),
        targetRef:binding.destinationRef,readOnly:true});
      observation=await readImageConsumerReceipt({contract,store,...binding,at});
    } catch (error) {
      observation={receipt:null,copyHealth:'UNKNOWN',reason:error.code==='ENOENT'?'RECEIVER_STORE_MISSING':error.code==='RECEIPT_BINDING'?'RECEIPT_BINDING':safeArtifactCode(error)};
    }
    evidence.push({...binding,...observation});
  }
  return evidence;
}

if (process.argv[1]===fileURLToPath(import.meta.url)) {
  try {
    const raw=readFileSync(0,'utf8');
    if (Buffer.byteLength(raw)>2_000_000 || process.argv[2]!=='read') throw new Error('IMAGE_RECEIVER_PAYLOAD');
    const input=JSON.parse(raw);
    process.stdout.write(JSON.stringify(await readReceiverEvidence(input)));
  } catch {process.stderr.write(JSON.stringify({error:'IMAGE_RECEIVER_READ_FAILED'}));process.exitCode=2;}
}
