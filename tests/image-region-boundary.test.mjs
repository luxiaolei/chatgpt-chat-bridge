import test from 'node:test';
import assert from 'node:assert/strict';
import {imageCli} from '../src/capabilities/image/chatgpt-ego.cli.js';
import {request,grant,scenario} from './image-execution-fixtures.mjs';

test('advertised region capability cannot bypass mask rejection at host prepare or reserve an adapter attempt',async()=>{
  const source={artifactRef:'artifact:offline:source',sha256:'2'.repeat(64),revisionId:'offline-source-revision',jobId:'offline-parent',outputId:'offline-output'};
  for(const mode of ['native-region','deterministic-composite'])for(const capability of ['NATIVE','ASSISTED']) {
    const r=request({operation:'edit',inputs:[{...source,role:'source'}],baseRevision:source,
      mask:{artifactRef:'artifact:offline:mask',sha256:'3'.repeat(64),sourceSha256:source.sha256,sourceRevisionId:source.revisionId,
        width:16,height:16,coordinateSpace:'source-pixels',mode}});
    const g=grant(r);g.capabilities.features.edit.mode=capability;
    g.capabilities.features[mode==='native-region'?'mask':'deterministicComposite']={mode:capability,evidence:['urn:offline:declared-region-capability']};
    const x=scenario({r,g});let coordinatorCalls=0,sourceReads=0,uiRounds=0;
    x.api.submit=()=>{coordinatorCalls++;assert.fail('mask must fail before submission');};
    x.ports.resolveSource=async()=>{sourceReads++;assert.fail('mask must fail before source I/O');};
    x.ports.withUi=async()=>{uiRounds++;assert.fail('mask must fail before UI access');};
    await assert.rejects(imageCli('prepare',{request:r,grantId:g.grantId},{liveAction:'start',coordinated:()=>{
      coordinatorCalls++;assert.fail('mask prepare must not create/inspect a job');
    }}),/IMAGE_MASK_UNSUPPORTED/);
    await assert.rejects(x.adapter().start(r,x.options),/IMAGE_MASK_UNSUPPORTED/);
    assert.deepEqual([coordinatorCalls,sourceReads,uiRounds,x.job().attempts.length,x.state.uploads,x.state.fills,x.state.sends],[0,0,0,0,0,0,0]);
  }
});
