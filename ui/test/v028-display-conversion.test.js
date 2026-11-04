import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paintDisplayCanvas} from '../src/frames/displayPortRouter.js';

test('DISPLAY RGB24 conversion preserves every channel, alpha and scratch reuse',()=>{
  for (const [width,height] of [[1,1],[3,5],[64,17]]) {
    const source=new Uint8Array(width*height*3+1);
    const bytes=source.subarray(1);
    let allocations=0, painted;
    const canvas={width:0,height:0,getContext:()=>({
      createImageData(w,h){allocations++;return {data:new Uint8ClampedArray(w*h*4)};},
      putImageData(image){painted=image.data;},
    })};
    for (const seed of [0,97,255]) {
      for(let i=0;i<bytes.length;i++) bytes[i]=(i*37+seed)&255;
      assert.equal(paintDisplayCanvas(canvas,{width,height,bytes}),true);
      const expected=new Uint8ClampedArray(width*height*4);
      for(let pixel=0;pixel<width*height;pixel++) {
        expected.set(bytes.subarray(pixel*3,pixel*3+3),pixel*4);
        expected[pixel*4+3]=255;
      }
      assert.deepEqual(painted,expected);
    }
    assert.equal(allocations,1);
    assert.equal(paintDisplayCanvas(canvas,{width,height,bytes:bytes.subarray(1)}),false);
  }
});
