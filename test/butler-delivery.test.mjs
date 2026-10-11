import test from 'node:test';
import assert from 'node:assert/strict';
import {matchReplyPane,routeInstruction,validateInstruction,createButlerDelivery} from '../src/butler-delivery.mjs';
import {createOtty} from '../src/otty.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const target={id:'codex:one',projectId:'bobo',name:'bobo',source:'codex',sessionId:'one',title:'实现 bobo 管家',directory:'/tmp/bobo'};
const pane={id:'pane-one',agent:'Codex',cwd:'/tmp/bobo',process:'⠇ 实现 bobo 管家 | bobo'};
const png='iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DA8B+MgBgAHfAD/dPQfSYAAAAASUVORK5CYII=';

test('图片粘贴校验：纯图片可发；拒绝超限、伪造格式及客户端路径',()=>{
 const image={mimeType:'image/png',data:png};
 const valid=validateInstruction({text:'',attachments:[image]});
 assert.equal(valid.text,'请查看附图。');assert.equal(valid.attachmentIds.length,1);
 assert.equal(valid.attachments[0].data.toString('base64'),png);
 for(const attachments of [{},Array(5).fill(image),[{...image,mimeType:'image/svg+xml'}],[{...image,data:'not png'}],[{path:'/etc/passwd'}],[{...image,data:'a'.repeat(5592409)}]])assert.throws(()=>validateInstruction({text:'看看',attachments}));
 const huge=Buffer.from(png,'base64');huge.writeUInt32BE(100000,16);
 assert.throws(()=>validateInstruction({text:'看看',attachments:[{...image,data:huge.toString('base64')}]}),/尺寸/);
});

test('图片和指令送往同一个 pane；文件可读取、权限受限，重试复用内容路径',async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'bobo-reply-images-'));t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const calls=[],otty={available:()=>true,panes:async()=>[pane],submit:async(...args)=>calls.push(args)};
 const validated=validateInstruction({text:'请看这张截图',attachments:[{mimeType:'image/png',data:png}]});
 const delivery=createButlerDelivery({home,otty});
 await delivery.send(target,validated.prompt,validated.attachments);
 const file=path.join(home,'.bobo/butler/attachments',validated.attachmentIds[0]+'.png');
 assert.equal((await fs.readFile(file)).toString('base64'),png);assert.equal((await fs.stat(file)).mode&0o777,0o600);
 assert.equal(calls[0][0],pane.id);assert.ok(calls[0][1].includes(JSON.stringify(file)));assert.match(calls[0][1],/请看这张截图/);
 await delivery.send(target,validated.prompt,validated.attachments);assert.deepEqual(calls[1],calls[0]);
 assert.equal((await fs.readdir(path.dirname(file))).length,1);
});

test('发送仅匹配原会话；优先会话 ID，旧终端必须 Agent、目录、完整标题唯一匹配',()=>{
 assert.equal(matchReplyPane([pane],target).id,pane.id);
 assert.equal(matchReplyPane([{...pane,agent_session_id:'other'}],target),null);
 assert.equal(matchReplyPane([{...pane,agent:'Claude Code'}],target),null);
 assert.equal(matchReplyPane([{...pane,cwd:'/tmp/other'}],target),null);
 assert.equal(matchReplyPane([{...pane,process:'实现 bobo 管家的其他任务 | bobo'}],target),null);
 assert.equal(matchReplyPane([pane,{...pane,id:'pane-two'}],target),null,'同目录同标题不能猜');
 assert.equal(matchReplyPane([{...pane,agent_session_id:'codex:one',process:'renamed'}],target).id,pane.id);
 assert.equal(matchReplyPane([{...pane,agent_session_id:'one'},{...pane,id:'pane-two',agent_session_id:'one'}],target),null);
 assert.equal(matchReplyPane([{...pane,agent:'shell',agent_session_id:'one'}],target),null,'已退出 Agent 的 shell 不能接收指令');
 assert.equal(matchReplyPane([{...pane,agent:'Oh My Pi',process:'π ⠼ 实现 bobo 管家 | bobo'}],{...target,source:'omp'}).id,pane.id);
 assert.equal(matchReplyPane([{...pane,process:'⠇ CX | 实现 bobo 管家 | bobo'}],target).id,pane.id);
 assert.equal(matchReplyPane([{...pane,title:pane.process,process:'codex'}],target).id,pane.id,'有窗口标题时不能把进程名称当成会话标题');
});
test('直接输入在本机识别项目、完整标题和 Agent；模糊指令返回候选，多个会话不随便挑',()=>{
 const blog={...target,id:'claude:blog',projectId:'paper-blog',name:'paper-blog',source:'claude',sessionId:'blog',title:'发布博客'},other={...target,id:'claude:two',source:'claude',sessionId:'two',title:'优化管家头像'};
 assert.equal(routeInstruction('继续发布博客',[target,blog]).target.id,blog.id);
 assert.equal(routeInstruction('更新 bobo 的头像',[target,blog]).target.id,target.id);
 assert.equal(routeInstruction('继续通知岛工作',[target,blog]).target.id,target.id);
 assert.equal(routeInstruction('继续优化管家头像',[target,other,blog]).target.id,other.id);
 assert.equal(routeInstruction('让 Claude 继续 bobo',[target,other,blog]).target.id,other.id);
 assert.equal(routeInstruction('继续 bobo',[target,other,blog]).candidates.length,2);
 assert.equal(routeInstruction('继续处理',[target,blog]).candidates.length,2);
 assert.equal(routeInstruction('继续处理',[]).candidates.length,0);
});
test('引用来自对应的 bobo 消息，选中文本可引用，控制字符和伪造引用拒绝',()=>{
 const message={role:'butler',text:'构建通过，待真机验证。'};
 const validated=validateInstruction({text:'继续验证\r\n检查导出',quote:'待真机验证'},message);
 assert.equal(validated.text,'继续验证\n检查导出');assert.match(validated.prompt,/> 待真机验证\n\n我的新指令：\n继续验证\n检查导出$/);
 assert.equal(validateInstruction({text:'保持现状'}).prompt,'保持现状');
 assert.match(validateInstruction({text:'继续',quote:'原来的导出要求'},{...message,request:'这是原来的导出要求'}).prompt,/> 原来的导出要求/);
 assert.throws(()=>validateInstruction({text:'继续',quote:'已发布'},message),/引用内容已变化/);
 assert.throws(()=>validateInstruction({text:'继续'}, {...message,role:'user'}),/bobo 消息/);
 assert.throws(()=>validateInstruction({text:'继续'},{role:'butler',text:'结果\x1b[201~'}),/引用包含无效控制字符/);
 for(const text of ['', 'a'.repeat(4097),'运行\x1b[201~\nrm -rf','运行\u0000','运行\u009b201~'])assert.throws(()=>validateInstruction({text}));
});
test('缺失、重名和等待回答的会话不能投递；指令仅发往匹配 pane',async()=>{
 const sent=[],focused=[],otty={available:()=>true,panes:async()=>[pane],submit:async(...args)=>sent.push(args),focusPane:async id=>{focused.push(id);return {ok:true,pane:id};}};
 assert.equal((await createButlerDelivery({otty}).focus(target)).ok,true);assert.deepEqual(focused,[pane.id]);
 assert.equal(await createButlerDelivery({otty:{...otty,panes:async()=>[{...pane,agent_session_id:'other'}]}}).focus(target),null);
 await createButlerDelivery({otty}).send(target,'指令');assert.deepEqual(sent,[[pane.id,'指令']]);
 await assert.rejects(()=>createButlerDelivery({otty,sessionState:()=> 'waiting'}).send(target,'不发送'),/等待你回答/);
 await assert.rejects(()=>createButlerDelivery({otty:{...otty,panes:async()=>[pane,{...pane,id:'other'}]}}).send(target,'不发送'),/唯一匹配/);
 await assert.rejects(()=>createButlerDelivery({otty:{...otty,panes:async()=>[{...pane,agent_state:'permission'}]}}).send(target,'不发送'),/等待你回答/);
 await assert.rejects(()=>createButlerDelivery({otty,enabled:false}).send(target,'不发送'),/暂支持 Otty/);
 assert.equal(sent.length,1);
});
test('多行指令经 stdin 一次粘贴和提交，不进入参数；未确认送达不报成功',async()=>{
 const calls=[],activations=[],otty=createOtty({exists:()=>true,open:()=>activations.push(true),exec:async(bin,args,input)=>{calls.push({bin,args,input});return {code:0,out:JSON.stringify({ok:true,data:[]})};}});
 const text='原样保留 \\n、`代码`、$(文本)\n这是第二行';await otty.submit('pane-one',text);
 assert.equal(calls[0].input,'\x1b[200~'+text+'\x1b[201~\r');assert.ok(calls[0].args.includes('--no-escape'));assert.ok(calls[0].args.includes('--raw-newlines'));
 assert.doesNotMatch(calls[0].args.join(' '),/原样保留|第二行/);
 assert.equal((await otty.focusPane('pane-one')).pane,'pane-one');assert.deepEqual(calls[1].args,['pane','focus','--pane','pane-one','--json']);assert.equal(activations.length,1);
 for(const result of [{code:1,out:''},{code:0,out:'{}'},{code:0,out:'not json'}]){
  const disconnected=createOtty({exec:async()=>result});await assert.rejects(()=>disconnected.submit('pane',text),/未确认指令送达/);
 }
});

test('Otty 明确拒绝程序输入时提示配置原因，允许开启后重试；未知失败仍不自动重发',async()=>{
 const disabled=createOtty({exec:async()=>({code:7,out:'',err:'error: send-text is disabled. Set `ipc-allow-send-keys = true` in your config to enable it.'})});
 await assert.rejects(()=>disabled.submit('pane','继续'),e=>e.status===409&&e.action==='enable-otty-input'&&/尚未发送/.test(e.message));
 const missing=createOtty({exec:async()=>({code:1,out:'',err:'error: No pane matched selector'})});
 await assert.rejects(()=>missing.submit('pane','继续'),e=>e.status===409);
 const unknown=createOtty({exec:async()=>({code:1,out:'',err:'connection lost'})});
 await assert.rejects(()=>unknown.submit('pane','继续'),e=>e.status===undefined&&/未确认/.test(e.message));
});

test('一键开启只设置 Otty 本机输入权限并重载，读回生效后才成功',async()=>{
 const calls=[];
 const otty=createOtty({exists:()=>true,exec:async(bin,args)=>{
  calls.push(args);return {code:0,out:JSON.stringify({ok:true,data:{value:'true'}})};
 }});
 assert.equal((await otty.enableInput()).ok,true);
 assert.deepEqual(calls,[['config','set','ipc-allow-send-keys','true','--local','--json'],['config','reload','--json'],['config','get','ipc-allow-send-keys','--json']]);
 for(const response of [{code:1,out:''},{code:0,out:'{}'},{code:0,out:JSON.stringify({ok:true,data:{value:'false'}})}]){
  const broken=createOtty({exists:()=>true,exec:async()=>response});
  await assert.rejects(()=>broken.enableInput(),e=>e.status===409&&e.action==='enable-otty-input');
 }
 await assert.rejects(()=>createButlerDelivery({enabled:false,otty:{enableInput:()=>assert.fail('隔离环境不能改本机配置')}}).enableInput(),/隔离环境/);
});

test('配置文件已开启不等于 IPC 生效：独立重载、空输入探测后才发送正文',async()=>{
 let disk=false,live=false;const calls=[];
 const otty=createOtty({exists:()=>true,exec:async(bin,args,input)=>{
  calls.push({args,input});
  let data=null;
  if(args[0]==='pane'&&args[1]==='list')data=[pane];
  else if(args[0]==='config'&&args[1]==='set')disk=true;
  else if(args[0]==='config'&&args[1]==='reload')live=disk;
  else if(args[0]==='config'&&args[1]==='get')data={value:String(disk)};
  else if(args[1]==='send-text'&&!live)return {code:7,out:'',err:'send-text is disabled'};
  return {code:0,out:JSON.stringify({ok:true,data})};
 }});
 const delivery=createButlerDelivery({otty});
 await delivery.enableInput(target);
 const check=calls.at(-1);assert.equal(check.input,'');assert.deepEqual(check.args.slice(0,4),['pane','send-text','--pane',pane.id]);
 assert.equal(calls.filter(c=>c.input!==undefined&&c.input!=='').length,0,'开启阶段不能先发正文或回车');
 await delivery.send(target,'继续处理');assert.equal(calls.at(-1).input,'\x1b[200~继续处理\x1b[201~\r');
 const stale=createOtty({exec:async()=>({code:7,out:'',err:'send-text is disabled'})});
 await assert.rejects(()=>stale.checkInput(pane.id),e=>e.status===409&&e.action==='enable-otty-input');
});

test('独立重载失败时停止，不宣称输入权限生效',async()=>{
 const calls=[];
 const otty=createOtty({exists:()=>true,exec:async(bin,args)=>{
  calls.push(args);return args[1]==='reload'?{code:1,out:'',err:'not running'}:{code:0,out:'{"ok":true}'};
 }});
 await assert.rejects(()=>otty.enableInput(),/未完成重载/);
 assert.equal(calls.length,2);
});
