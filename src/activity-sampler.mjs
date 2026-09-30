// 设备 / 网络常驻时低频采样；可见界面的请求续期后恢复正常频率。
// 空闲时直接延长下一跳的定时器，不用高频 timer 空转检查是否有人在看。
export function createActivitySampler({sample,now=Date.now,activeMs=3000,idleMs=15000,watchMs=10000,setTimer=setTimeout,clearTimer=clearTimeout}){
 let running=false,timer=null,sampling=false,activeUntil=0,generation=0;
 const active=()=>now()<activeUntil;
 function schedule(){
  timer=setTimer(()=>{timer=null;void run(false);},active()?activeMs:idleMs);
  timer?.unref?.();
 }
 async function run(all){
  const current=generation;
  sampling=true;
  try{await sample(all);}catch{}
  finally{if(running&&current===generation){sampling=false;schedule();}}
 }
 return {
  start(){if(running)return;running=true;generation++;void run(true);},
  watch(){
   const wasActive=active();
   activeUntil=now()+watchMs;
   if(running&&!wasActive&&!sampling){clearTimer(timer);schedule();}
  },
  stop(){running=false;generation++;sampling=false;activeUntil=0;clearTimer(timer);timer=null;},
 };
}
