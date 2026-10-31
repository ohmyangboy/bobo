// DeepSeek 官方人民币价格快照（元 / 百万 tokens），核对日期不是追溯生效日期。
export const AI_PRICING={version:'deepseek-cny-2026-10-21',updatedAt:'2026-10-21',currency:'CNY',source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'};
const flash={hit:0.02,miss:1,output:4},pro={hit:0.15,miss:4.5,output:13.5};
const prices={'deepseek-flash':flash,'deepseek-v4-flash':flash,'deepseek-v4-flash-vision-exp':flash,'deepseek-v4-pro':pro};
export function isOfficialDeepSeek(baseUrl){
 let url;try{url=new URL(baseUrl);}catch{return false;}
 return url.origin==='https://api.deepseek.com'&&['/','/v1','/v1/','/beta','/beta/'].includes(url.pathname)&&!url.username&&!url.password&&!url.search&&!url.hash;
}
export function snapshotAIPrice({baseUrl,model}={}){
 if(!isOfficialDeepSeek(baseUrl)||!Object.hasOwn(prices,model))return null;
 const offPeak={...prices[model]},peak=Object.fromEntries(Object.entries(offPeak).map(([key,value])=>[key,value*2]));
 return {...AI_PRICING,modelVersion:model==='deepseek-v4-pro'?'DeepSeek-V4-Pro-0813':'DeepSeek-V4.1-Flash-1017',unit:'CNY/1000000 tokens',offPeak,peak,peakTimezone:'Asia/Shanghai',holidayCalendarKnown:false};
}
export function estimateAICost(usage,{baseUrl,model,at}={}){
 if(!usage||!Number.isFinite(at)||!isOfficialDeepSeek(baseUrl))return null;
 const price=Object.hasOwn(prices,model)?prices[model]:null;if(!price)return null;
 const date=new Date(at+8*3600000);if(!Number.isFinite(date.getTime()))return null;const day=date.getUTCDay(),hour=date.getUTCHours();
 // 不维护法定节假日日历：工作日高峰窗口给出两档价格的区间，其余时段用空闲价。
 const peak=day>=1&&day<=5&&(hour>=9&&hour<12||hour>=14&&hour<18);
 const hitMin=usage.cacheKnown?usage.cachedInput:0,hitMax=usage.cacheKnown?usage.cachedInput:usage.input;
 const cost=hit=>(hit*price.hit+(usage.input-hit)*price.miss+usage.output*price.output)/1000000;
 return {min:cost(hitMax),max:cost(hitMin)*(peak?2:1)};
}
