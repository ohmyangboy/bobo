import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createActivitySampler} from '../src/activity-sampler.mjs';

const settle=()=>new Promise(r=>setImmediate(r));
function clock(){
 let at=0,seq=0;
 const timers=new Map();
 return {
  now:()=>at,
  setTimer(fn,delay){const id=++seq;timers.set(id,{fn,at:at+delay});return id;},
  clearTimer(id){timers.delete(id);},
  count:()=>timers.size,
  async advance(ms){
   const end=at+ms;
   for(;;){
    const next=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
    if(!next||next[1].at>end)break;
    at=next[1].at;timers.delete(next[0]);next[1].fn();await settle();
   }
   at=end;await settle();
  },
 };
}
test('采样：常驻每 15 秒，使用时每 3 秒，续期不会饿死采样，离开后自动降频',async()=>{
 const h=clock(),calls=[];
 const sampler=createActivitySampler({...h,sample:async all=>calls.push({at:h.now(),all})});
 sampler.start();sampler.start();await settle();
 assert.deepEqual(calls,[{at:0,all:true}]);assert.equal(h.count(),1);
 await h.advance(14999);assert.equal(calls.length,1);
 await h.advance(1);assert.deepEqual(calls.at(-1),{at:15000,all:false});
 sampler.watch();await h.advance(2999);assert.equal(calls.length,2);
 await h.advance(1);assert.equal(calls.at(-1).at,18000);
 // 每次界面请求续期，但不重置已经排好的下一跳。
 sampler.watch();await h.advance(1000);sampler.watch();await h.advance(2000);
 assert.equal(calls.at(-1).at,21000);
 await h.advance(9000);assert.equal(calls.at(-1).at,30000);
 const count=calls.length;
 await h.advance(14999);assert.equal(calls.length,count);
 await h.advance(1);assert.equal(calls.at(-1).at,45000);
 sampler.stop();assert.equal(h.count(),0);await h.advance(60000);assert.equal(calls.length,count+1);
});
test('采样：请求撞上慢采样不会重叠，停止后的异步完成不会重新启动定时器',async()=>{
 const h=clock();let finish,calls=0;
 const sampler=createActivitySampler({...h,sample:()=>{calls++;return new Promise(r=>{finish=r;});}});
 sampler.start();sampler.watch();await h.advance(60000);
 assert.equal(calls,1);assert.equal(h.count(),0);
 sampler.stop();finish();await settle();assert.equal(h.count(),0);
 sampler.start();sampler.watch();finish();await settle();
 assert.equal(h.count(),1);sampler.stop();
});
test('采样：失败仍会继续下一跳，停止 / 重新启动时旧采样不会多挂一份 timer',async()=>{
 const h=clock();let finish,calls=0;
 const sampler=createActivitySampler({...h,sample:()=>{
  calls++;if(calls===1)return new Promise(r=>{finish=r;});throw Error('sample failed');
 }});
 sampler.start();sampler.stop();sampler.start();await settle();
 finish();await settle();assert.equal(h.count(),1);
 await h.advance(15000);assert.equal(calls,3);assert.equal(h.count(),1);
 sampler.stop();
});
