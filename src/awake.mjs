import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
const invalid=message=>Object.assign(Error(message),{status:400});
export const awakeDefaults=Object.freeze({defaultDuration:'1h',allowDisplaySleep:false,allowSystemSleepOnDisplayOff:false,launchAtLogin:false});
export const awakeDurations=['30m','45m','1h','2h','4h','8h','永久'];
export function normalizeAwakeSettings(input,current=awakeDefaults){
 const next={...current};
 if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('保持唤醒设置格式无效');
 for(const key of Object.keys(input)){
  if(!Object.hasOwn(awakeDefaults,key))throw invalid('未知保持唤醒设置：'+key);
  if(key==='defaultDuration'){
   if(!awakeDurations.includes(input[key]))throw invalid('请选择有效的默认时长');
  }else if(typeof input[key]!=='boolean')throw invalid('保持唤醒开关必须为布尔值');
  next[key]=input[key];
 }
 return next;
}

// 网页只保存设置；私有电源 API、状态机与登录项仍由内置 Swift CLI 负责。
// exec 与文件根目录可注入；BOBO_HOME / 非 macOS 永远不会调用真实 launchctl。
export function createAwake({home,executable,platform=process.platform,isolated=!!process.env.BOBO_HOME,exec}={}){
 const file=path.join(home,'.bobo/awake.json');let saving=false;
 const command=exec||((args)=>run(executable,args,{shell:false,timeout:6000,env:{...process.env,AWAKE_HOME:home}}));
 async function settings(){
  try{return normalizeAwakeSettings(JSON.parse(await fs.readFile(file,'utf8')));}
  catch(e){if(e.code==='ENOENT')return {...awakeDefaults};throw e;}
 }
 async function save(input){
  if(saving)throw Object.assign(Error('保持唤醒设置正在保存'),{status:409});
  saving=true;
  try{
   const old=await settings(),next=normalizeAwakeSettings(input,old);
   if(next.launchAtLogin&&(platform!=='darwin'||(isolated&&!exec)))throw Error('登录时启动需要 macOS 应用内置的 awake');
   const existed=await fs.readFile(file).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
   await fs.mkdir(path.dirname(file),{recursive:true});
   const temporary=file+'.tmp';
   await fs.writeFile(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600});await fs.rename(temporary,file);
   try{if(old.launchAtLogin||next.launchAtLogin)await command(['login-sync']);}
   catch{
    if(existed)await fs.writeFile(file,existed,{mode:0o600});else await fs.rm(file,{force:true});
    throw Error('登录项设置失败，已恢复原设置；可继续手动开启保持唤醒');
   }
   return next;
  }finally{saving=false;}
 }
 return {settings,save};
}
