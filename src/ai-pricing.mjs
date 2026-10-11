// DeepSeek 官方人民币价格快照（元 / 百万 tokens），2026-10-10 核对。
export const AI_PRICING={updatedAt:'2026-10-10',source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'};
const flash={hit:0.02,miss:1,output:4},pro={hit:0.15,miss:4.5,output:13.5};
const prices={'deepseek-flash':flash,'deepseek-v4-flash':flash,'deepseek-v4-flash-vision-exp':flash,'deepseek-v4-pro':pro};
export function estimateAICost(usage,{baseUrl,model,at}={}){
 if(!usage||!Number.isFinite(at))return null;
 let url;try{url=new URL(baseUrl);}catch{return null;}
 const price=Object.hasOwn(prices,model)?prices[model]:null;
 if(!price||url.origin!=='https://api.deepseek.com'||!['/','/v1','/v1/','/beta','/beta/'].includes(url.pathname)||url.username||url.password||url.search||url.hash)return null;
 const date=new Date(at+8*3600000);if(!Number.isFinite(date.getTime()))return null;const day=date.getUTCDay(),hour=date.getUTCHours();
 // 不维护法定节假日日历：工作日高峰窗口给出两档价格的区间，其余时段用空闲价。
 const peak=day>=1&&day<=5&&(hour>=9&&hour<12||hour>=14&&hour<18);
 const hitMin=usage.cacheKnown?usage.cachedInput:0,hitMax=usage.cacheKnown?usage.cachedInput:usage.input;
 const cost=hit=>(hit*price.hit+(usage.input-hit)*price.miss+usage.output*price.output)/1000000;
 return {min:cost(hitMax),max:cost(hitMin)*(peak?2:1)};
}
