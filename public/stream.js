// TextDecoder 保留跨网络块的 UTF-8 字节，行缓存同时支持 LF 与 CRLF。
export async function* responseLines(response){
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
 try{while(true){const {value,done}=await reader.read();buffer+=done?decoder.decode():decoder.decode(value,{stream:true});let end;while((end=buffer.indexOf('\n'))>=0){yield buffer.slice(0,end).replace(/\r$/,'');buffer=buffer.slice(end+1);}if(done)break;}if(buffer)yield buffer.replace(/\r$/,'');}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
