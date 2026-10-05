import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferAttribute } from 'three';
import { queueBufferUpdate } from '../src/render/BufferUpdates';
test('hidden pending attribute changes remain one bounded union until an actual upload',()=>{
  const attribute=new BufferAttribute(new Float32Array(4000),3);
  for(let i=0;i<10000;i++){queueBufferUpdate(attribute,(i*37)%3000,3);assert.equal(attribute.updateRanges.length,1);}
  assert.deepEqual(attribute.updateRanges,[{start:0,count:3002}]);
  const version=attribute.version;queueBufferUpdate(attribute,0,0);assert.equal(attribute.version,version);
  // Three clears ranges after uploading. A later change may start a new bounded union.
  attribute.clearUpdateRanges();queueBufferUpdate(attribute,55,2);assert.deepEqual(attribute.updateRanges,[{start:55,count:2}]);
});
