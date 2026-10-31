import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AI_PRICING,estimateAICost,isOfficialDeepSeek,snapshotAIPrice} from './ai-pricing.mjs';

export const AI_FEATURES={'butler':'管家','skill:summary':'技能总结','skill:translate':'技能翻译','agent:summary':'智能体总结','agent:translate':'智能体翻译','config:summary':'配置总结','config:translate':'配置翻译'};
const empty=()=>({requests:0,measured:0,unmeasured:0,input:0,output:0,total:0,cachedInput:0,cacheMeasured:0,reasoning:0,pricedRequests:0,costCnyMin:0,costCnyMax:0});
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const validStoredRequest=r=>r&&typeof r==='object'&&typeof r.requestId==='string'&&Number.isFinite(r.at)&&/^\d{4}-\d{2}-\d{2}$/.test(r.day)&&typeof r.model==='string'&&(r.usage===null||r.usage&&['input','output','total','cachedInput','reasoning'].every(key=>count(r.usage[key])!==null)&&typeof r.usage.cacheKnown==='boolean')&&(r.estimatedCost===null||r.estimatedCost&&Number.isFinite(r.estimatedCost.min)&&Number.isFinite(r.estimatedCost.max)&&r.estimatedCost.min>=0&&r.estimatedCost.max>=r.estimatedCost.min);
export function parseAIUsage(value){
 if(!value||typeof value!=='object')return null;
 const input=count(value.prompt_tokens??value.input_tokens),output=count(value.completion_tokens??value.output_tokens);
 if(input===null||output===null)return null;
 const miss=count(value.prompt_cache_miss_tokens),hit=count(value.prompt_cache_hit_tokens??value.prompt_tokens_details?.cached_tokens??value.input_tokens_details?.cached_tokens);
 const cached=hit??(miss!==null&&miss<=input?input-miss:null);
 if(cached!==null&&(cached>input||miss!==null&&cached+miss!==input))return null;
 return {input,output,total:count(value.total_tokens)??input+output,cachedInput:Math.min(input,cached??0),cacheKnown:cached!==null,reasoning:Math.min(output,count(value.completion_tokens_details?.reasoning_tokens??value.output_tokens_details?.reasoning_tokens)??0)};
}
const add=(target,usage,cost)=>{target.requests++;if(usage){target.measured++;for(const key of ['input','output','total','cachedInput','reasoning'])target[key]+=usage[key];if(usage.cacheKnown)target.cacheMeasured++;}else target.unmeasured++;if(cost){target.pricedRequests++;target.costCnyMin+=cost.min;target.costCnyMax+=cost.max;}};
const decorateDeepSeek=value=>{const result=decorate(value);for(const key of ['input','output','total','cachedInput','reasoning'])if(!value.measured)result[key]=null;for(const key of ['costCnyMin','costCnyMax'])if(!value.pricedRequests)result[key]=null;return {...result,partial:value.unmeasured>0};};
const decorate=value=>({...value,cacheRate:value.input&&(value.cacheMeasured||value.cachedInput)?value.cachedInput/value.input:value.cacheMeasured?0:null,cachePartial:value.measured>value.cacheMeasured,unpricedRequests:value.requests-value.pricedRequests});
export function createAIUsage(home,{now=Date.now,timezone=Intl.DateTimeFormat().resolvedOptions().timeZone}={}){
 const file=path.join(home,'.bobo','ai-usage.json');
 let state=null,loaded=null,queue=Promise.resolve(),error='',deepseekDate;
 const dateFormat=zone=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
 function load(){return loaded??=read();}
 async function read(){
  try{
   const raw=JSON.parse(await fs.readFile(file,'utf8'));if(![1,2,3].includes(raw.version)||!raw.features||!raw.days)throw Error('格式无效');
   // 旧版只存 token 合计，缺少请求时的模型、价格与缓存字段覆盖率，不能追溯费用。
   for(const bucket of [raw.features,...Object.values(raw.days)])for(const id of Object.keys(bucket))bucket[id]={...empty(),...bucket[id]};
   if(raw.deepseek&&(!Array.isArray(raw.deepseek.requests)||!Number.isFinite(raw.deepseek.since)||!raw.deepseek.requests.every(validStoredRequest)))throw Error('格式无效');
   const zone=raw.deepseek?.timezone??timezone;deepseekDate=dateFormat(zone);
   state={...raw,version:3,deepseek:{...(raw.deepseek??{since:now(),requests:[]}),timezone:zone}};
  }catch(e){deepseekDate=dateFormat(timezone);state={version:3,since:now(),features:{},days:{},deepseek:{since:now(),timezone,requests:[]}};if(e.code!=='ENOENT')error='用量记录无法读取；本次运行的统计尚未落盘';}
 }
 function day(at=now()){const d=new Date(at);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
 // 台账日期固定使用初次记录的时区，系统换时区后也不改变分组口径。
 function deepseekDay(at){const parts=Object.fromEntries(deepseekDate.formatToParts(new Date(at)).map(p=>[p.type,p.value]));return parts.year+'-'+parts.month+'-'+parts.day;}
 async function record(feature,raw,metadata={}){
  if(!Object.hasOwn(AI_FEATURES,feature))throw Error('未知的 AI 用量分类');
  const task=queue.then(async()=>{
   await load();
   const requestId=typeof metadata.requestId==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(metadata.requestId)?metadata.requestId:randomUUID();
   if(state.deepseek.requests.some(r=>r.requestId===requestId))return;
   const at=Number.isFinite(metadata.at)&&Number.isFinite(new Date(metadata.at).getTime())?metadata.at:now(),usage=parseAIUsage(raw),key=day(at),cost=estimateAICost(usage,metadata);
   const today=state.days[key]??={};add(state.features[feature]??=empty(),usage,cost);add(today[feature]??=empty(),usage,cost);
   const lastRequest={at:metadata.at??now(),input:usage?.input??null,output:usage?.output??null,total:usage?.total??null,cachedInput:usage?.cacheKnown?usage.cachedInput:null,cacheRate:usage?.cacheKnown?(usage.input?usage.cachedInput/usage.input:0):null,costCnyMin:cost?.min??null,costCnyMax:cost?.max??null};
   state.features[feature].lastRequest=lastRequest;today[feature].lastRequest=lastRequest;
   if(isOfficialDeepSeek(metadata.baseUrl)){
    const model=typeof metadata.model==='string'&&metadata.model.length<=200?metadata.model:'未知模型',price=snapshotAIPrice(metadata);
    state.deepseek.requests.push({requestId,at,day:deepseekDay(at),feature,model,responseModel:typeof metadata.responseModel==='string'?metadata.responseModel.slice(0,200):null,usage,estimatedCost:cost,priceVersion:price?.version??null,price});
   }
   for(const old of Object.keys(state.days).sort().slice(0,-31))delete state.days[old];
   // 读坏的历史文件不覆盖；界面仍显示本次进程观察到的用量及存储错误。
   if(error)return;
   try{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(state),{mode:0o600});await fs.chmod(file+'.tmp',0o600);await fs.rename(file+'.tmp',file);}
   catch{error='用量记录保存失败；本次运行的统计尚未落盘';}
  });
  queue=task.catch(()=>{});await task;
 }
 async function snapshot(){
  await queue;await load();const total=empty(),todayTotal=empty();
  const features=Object.entries(AI_FEATURES).map(([id,label])=>{const all={...empty(),...state.features[id]},today={...empty(),...state.days[day()]?.[id]};for(const key of Object.keys(total)){total[key]+=all[key];todayTotal[key]+=today[key];}return {id,label,...decorate(all),today:decorate(today)};});
  const dsTotal=empty(),models=new Map(),days=new Map();
  function modelBucket(bucket,model){if(!bucket.has(model))bucket.set(model,{model,...empty(),pricingVersions:[]});return bucket.get(model);}
  for(const request of state.deepseek.requests){
   const cost=request.estimatedCost,usage=request.usage;add(dsTotal,usage,cost);
   const daily=days.get(request.day)??new Map();days.set(request.day,daily);
   for(const bucket of [modelBucket(models,request.model),modelBucket(daily,request.model)]){add(bucket,usage,cost);if(request.priceVersion&&!bucket.pricingVersions.includes(request.priceVersion))bucket.pricingVersions.push(request.priceVersion);}
  }
  const deepseek={since:state.deepseek.since,scope:'bobo-observed-official-deepseek',timezone:state.deepseek.timezone,total:decorateDeepSeek(dsTotal),models:[...models.values()].map(decorateDeepSeek),days:[...days].sort(([a],[b])=>b.localeCompare(a)).map(([day,bucket])=>({day,models:[...bucket.values()].map(decorateDeepSeek)})),recent:state.deepseek.requests.slice(-20).reverse()};
  return {since:state.since,day:day(),features,total:decorate(total),today:decorate(todayTotal),pricing:AI_PRICING,deepseek,error};
 }
 return {record,snapshot};
}
