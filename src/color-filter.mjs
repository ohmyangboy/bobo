import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appBundlePath} from './update.mjs';

const run=promisify(execFile);
const kinds=new Set([1,2,4,8,16]);
const invalid=message=>Object.assign(Error(message),{status:400});
const unavailable=reason=>({supported:false,available:false,enabled:false,type:0,intensity:1,intensityMin:0.25,intensityMax:1,hue:0,adjustable:false,reason});
export function parseColorFilterSnapshot(text){
 const value=JSON.parse(text);
 if(!value||typeof value.reason!=='string')throw Error('色彩滤镜状态无效');
 for(const key of ['supported','available','enabled','adjustable'])if(typeof value[key]!=='boolean')throw Error('色彩滤镜状态无效');
 if(!Number.isInteger(value.type)||!(value.type===0||kinds.has(value.type)))throw Error('色彩滤镜状态无效');
 for(const key of ['intensity','intensityMin','intensityMax','hue'])if(typeof value[key]!=='number'||!Number.isFinite(value[key]))throw Error('色彩滤镜状态无效');
 if(value.intensityMin>=value.intensityMax||value.hue<0||value.hue>1)throw Error('色彩滤镜状态无效');
 if(value.supported!==value.available)throw Error('色彩滤镜状态无效');
 return value;
}

// 只调用当前 App 的固定命令。隔离 HOME / 非原生壳不改真实的系统色彩滤镜。
export function createColorFilter({platform=process.platform,argv1=process.argv[1],isolated=!!process.env.BOBO_HOME,exec}={}){
 const bundle=appBundlePath(argv1);
 const supported=platform==='darwin'&&!!bundle&&(!isolated||!!exec);
 const executable=bundle?path.join(bundle,'Contents/MacOS/Bobo'):null;
 const command=exec||((file,args)=>run(file,args,{shell:false,timeout:8000,maxBuffer:64*1024}));
 let busy=false;
 async function invoke(args){
  const result=await command(executable,args);
  return parseColorFilterSnapshot(typeof result==='string'?result:result.stdout);
 }
 function argumentsFor(input){
  const args=['--color-filter','apply'];
  if('type' in input)args.push('type',String(input.type));
  if('hue' in input)args.push('hue',String(input.hue));
  if('intensity' in input)args.push('intensity',String(input.intensity));
  if('enabled' in input)args.push('enabled',input.enabled?'true':'false');
  return args;
 }
 async function snapshot(){
  if(!supported)return unavailable('色彩滤镜仅支持 macOS 原生应用，请通过 bobo.app 设置');
  try{return await invoke(['--color-filter','status']);}catch{throw Error('无法读取系统色彩滤镜，请重新打开设备页后重试');}
 }
 async function save(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('色彩滤镜设置格式无效');
  const keys=Object.keys(input);
  if(!keys.length||keys.some(key=>!['enabled','type','intensity','hue'].includes(key)))throw invalid('色彩滤镜设置参数无效');
  if('enabled' in input&&typeof input.enabled!=='boolean')throw invalid('色彩滤镜设置参数无效');
  if('type' in input&&(!Number.isInteger(input.type)||!kinds.has(input.type)))throw invalid('不支持的色彩滤镜');
  if('intensity' in input&&(typeof input.intensity!=='number'||!Number.isFinite(input.intensity)||input.intensity<0||input.intensity>1))throw invalid('色彩滤镜强度无效');
  if('hue' in input&&(typeof input.hue!=='number'||!Number.isFinite(input.hue)||input.hue<0||input.hue>1))throw invalid('色调无效');
  if(!supported)throw invalid('色彩滤镜仅支持 macOS 原生应用，请通过 bobo.app 设置');
  if(busy)throw Object.assign(Error('色彩滤镜设置正在保存'),{status:409});
  busy=true;
  try{return await invoke(argumentsFor(input));}
  catch(error){throw Error(error.status===400?error.message:'色彩滤镜操作失败，请在系统设置的色彩滤镜中检查后重试');}
  finally{busy=false;}
 }
 return {snapshot,save};
}
