import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appBundlePath} from './update.mjs';

const run=promisify(execFile);
const invalid=message=>Object.assign(Error(message),{status:400});
const unavailable=reason=>({supported:false,enabled:false,registered:false,requiresApproval:false,status:'unavailable',reason});
export function parseLoginItemSnapshot(text){
 const value=JSON.parse(text);
 const states=['enabled','notRegistered','requiresApproval','notFound'];
 if(!value||!states.includes(value.status)||typeof value.reason!=='string')throw Error('登录项状态无效');
 for(const key of ['supported','enabled','registered','requiresApproval'])if(typeof value[key]!=='boolean')throw Error('登录项状态无效');
 if(value.enabled!==(value.status==='enabled')||value.requiresApproval!==(value.status==='requiresApproval')||value.registered!==(value.enabled||value.requiresApproval)||value.supported!==(value.status!=='notFound'))throw Error('登录项状态不一致');
 return value;
}

// 只允许调用当前 App 自己的固定命令；隔离 HOME / 非原生壳不触碰真实系统登录项。
export function createLoginItem({platform=process.platform,argv1=process.argv[1],isolated=!!process.env.BOBO_HOME,exec}={}){
 const bundle=appBundlePath(argv1);
 const supported=platform==='darwin'&&!!bundle&&(!isolated||!!exec);
 const executable=bundle?path.join(bundle,'Contents/MacOS/Bobo'):null;
 const command=exec||((file,args)=>run(file,args,{shell:false,timeout:8000,maxBuffer:64*1024}));
 let busy=false;
 async function invoke(action){
  const result=await command(executable,['--login-item',action]);
  return parseLoginItemSnapshot(typeof result==='string'?result:result.stdout);
 }
 async function snapshot(){
  if(!supported)return unavailable('登录时启动仅支持 macOS 原生应用，请通过 bobo.app 设置');
  try{return await invoke('status');}catch{throw Error('无法读取系统登录项状态，请重新打开设置后重试');}
 }
 async function save(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('登录项设置格式无效');
  const keys=Object.keys(input);
  let action;
  if(keys.length===1&&keys[0]==='enabled'&&typeof input.enabled==='boolean')action=input.enabled?'enable':'disable';
  else if(keys.length===1&&keys[0]==='openSettings'&&input.openSettings===true)action='settings';
  else throw invalid('登录项设置参数无效');
  if(!supported)throw invalid('登录时启动仅支持 macOS 原生应用，请通过 bobo.app 设置');
  if(busy)throw Object.assign(Error('登录项设置正在保存'),{status:409});
  busy=true;
  try{return await invoke(action);}
  catch{throw Error('登录项操作失败，请在系统设置的登录项中检查 bobo 后重试');}
  finally{busy=false;}
 }
 return {snapshot,save};
}
