import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// 验证切换分类时的编辑保护与来源加载竞争；不启动服务、不读取真实配置。
const source=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
function slice(start,end){
 const from=source.indexOf(start),to=source.indexOf(end,from);
 assert.ok(from>=0&&to>from,`找不到页面切片：${start}`);
 return source.slice(from,to);
}
function page({agentDirty=false,skillDirty=false,answer=true}={}){
 const nodes={'#agentEditor':{value:agentDirty?'changed':'original'},'#editor':{value:skillDirty?'changed':'original'},'#agentSearch':{value:'review'},'#agentList':{scrollTop:90},'#agentRoot':{textContent:''}};
 const questions=[],context=vm.createContext({$:id=>nodes[id],confirm:text=>{questions.push(text);return answer;},refreshAgentChrome(){},renderAgentList(){},applyAgentDetailChrome(){},renderAgentFacts(){},agentHasDefs:()=>true,agentMeta:()=>({skillAgent:'opencode'})});
 vm.runInContext(`
  let agentSection='config',agentFilter='review',agentProvider='opencode',agentDetailKind='config';
  let agentSel={id:'AGENTS.md'},agentOriginal='original',agentVersion='v1',agentRun=0;
  let selected={id:'skill'},current=${skillDirty?"'SKILL.md'":'null'},original='original',selectionRun=0,rightPane='agent';
  let agentLoaded=false,agentConfigLoaded=false,agentItems=[],agentConfigs=null;
  const agentIsConfig=()=>agentDetailKind==='config';
  function showPane(name){rightPane=name;}
 `+source.match(/^const agentSectionOK=.*$/m)[0]+
 slice('function dirty(){','function guard(')+
 slice('function agentDirty(){','// 来源切换：')+
 slice('function dropSkillSelection(){','// 四个一级视图：')+
 slice('function setAgentSection(section){','// 一次加载当前来源'),context);
 return {nodes,questions,context,run:code=>vm.runInContext(code,context),state:()=>JSON.parse(vm.runInContext('JSON.stringify({agentSection,agentFilter,agentSel,selected,current,rightPane})',context))};
}
test('Agents 分类：取消确认会保留未保存配置或技能及当前分类',()=>{
 for(const dirty of ['agentDirty','skillDirty']){
  const p=page({[dirty]:true,answer:false}),before=p.state();
  p.run("setAgentSection('skill')");
  assert.deepEqual(p.state(),before);
  assert.equal(p.questions.length,1);
  assert.equal(p.nodes['#agentSearch'].value,'review');
 }
});
test('Agents 分类：确认离开后清除旧选择和搜索，保持当前 Agent 来源',()=>{
 const p=page({agentDirty:true});p.run("setAgentSection('skill')");
 assert.deepEqual(p.state(),{agentSection:'skill',agentFilter:'',agentSel:null,selected:null,current:null,rightPane:'agentEmpty'});
 assert.equal(p.run('agentProvider'),'opencode');
 assert.equal(p.nodes['#agentSearch'].value,'');assert.equal(p.nodes['#agentList'].scrollTop,0);
 assert.equal(p.questions.length,1);
});
test('Agents 分类：来源不支持的分类不能进入',()=>{
 const p=page();p.context.agentHasDefs=()=>false;p.context.agentMeta=()=>({skillAgent:null});
 const before=p.state();p.run("setAgentSection('agent');setAgentSection('skill')");
 assert.deepEqual(p.state(),before);assert.equal(p.questions.length,0);
});
test('Agents 来源：旧来源的延迟响应不能覆盖新来源列表',async()=>{
 const p=page(),pending=[];
 p.context.api=()=>new Promise(resolve=>pending.push(resolve));
 p.context.agentConfigRoute=s=>'configs'+s;p.context.agentRoute=()=>p.run('agentProvider')+'/agents';
 p.run(slice('async function loadAgentAll(){','// 配置、智能体和技能各有独立列表'));
 p.run('agentSel=null');const old=p.run('loadAgentAll()');
 p.run("agentProvider='codex'");const current=p.run('loadAgentAll()');
 pending[2]({label:'Codex',dir:'/fixture/codex',files:[{key:'config.toml'}]});pending[3]({agents:[{id:'reviewer'}]});await current;
 pending[0]({label:'OpenCode',dir:'/fixture/opencode',files:[{key:'AGENTS.md'}]});pending[1]({agents:[]});await old;
 assert.equal(p.run('agentConfigs.label'),'Codex');assert.equal(p.run('agentItems[0].id'),'reviewer');
 assert.equal(p.nodes['#agentRoot'].textContent,'Codex · /fixture/codex');
});
