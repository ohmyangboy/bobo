// Agent 目录表：从 vercel-labs/skills（npm 包 skills@1.6.0，MIT）的 Agent 注册表抽取，
// 只保留「有全局技能目录」的 Agent。用途：把 ~/.agents/skills 里的技能链接到各 Agent 自己
// 的全局目录（CLI 安装技能时就是这么做的），并据此判断一个技能被哪些 Agent 看到。
// 每项：[id, 显示名, 全局技能目录模板, [安装检测路径模板…], 是否通用 Agent]。
// 通用 Agent（universal）直接读 ~/.agents/skills，不需要额外建链接；其余 Agent 需要在自己目录里建。
// 上游新增 Agent 时补这里即可（数据快照，不做自动同步）。
export const AGENT_TABLE = [
 ["aider-desk","AiderDesk","{home}/.aider-desk/skills",["{home}/.aider-desk"]],
 ["amp","Amp","{config}/agents/skills",["{config}/amp"],1],
 ["antigravity","Antigravity","{home}/.gemini/antigravity/skills",["{home}/.gemini/antigravity"],1],
 ["antigravity-cli","Antigravity CLI","{home}/.gemini/antigravity-cli/skills",["{home}/.gemini/antigravity-cli"],1],
 ["astrbot","AstrBot","{home}/.astrbot/data/skills",["{cwd}/data/skills","{home}/.astrbot"]],
 ["autohand-code","Autohand Code CLI","{autohand}/skills",["{autohand}"]],
 ["augment","Augment","{home}/.augment/skills",["{home}/.augment"]],
 ["bob","IBM Bob","{home}/.bob/skills",["{home}/.bob"]],
 ["claude-code","Claude Code","{claude}/skills",["{claude}"]],
 ["openclaw","OpenClaw","{home}/.openclaw/skills",["{home}/.openclaw","{home}/.clawdbot","{home}/.moltbot"]],
 ["cline","Cline","{home}/.agents/skills",["{home}/.cline"],1],
 ["codearts-agent","CodeArts Agent","{home}/.codeartsdoer/skills",["{home}/.codeartsdoer"]],
 ["codebuddy","CodeBuddy","{home}/.codebuddy/skills",["{cwd}/.codebuddy","{home}/.codebuddy"]],
 ["codemaker","Codemaker","{home}/.codemaker/skills",["{home}/.codemaker"]],
 ["codestudio","Code Studio","{home}/.codestudio/skills",["{home}/.codestudio"]],
 ["codex","Codex","{codex}/skills",["{codex}","/etc/codex"],1],
 ["command-code","Command Code","{home}/.commandcode/skills",["{home}/.commandcode"]],
 ["continue","Continue","{home}/.continue/skills",["{cwd}/.continue","{home}/.continue"]],
 ["cortex","Cortex Code","{home}/.snowflake/cortex/skills",["{home}/.snowflake/cortex"]],
 ["crush","Crush","{home}/.config/crush/skills",["{home}/.config/crush"]],
 ["cursor","Cursor","{home}/.cursor/skills",["{home}/.cursor"],1],
 ["deepagents","Deep Agents","{home}/.deepagents/agent/skills",["{home}/.deepagents"],1],
 ["devin","Devin for Terminal","{config}/devin/skills",["{config}/devin"]],
 ["dexto","Dexto","{home}/.agents/skills",["{home}/.dexto"],1],
 ["droid","Droid","{home}/.factory/skills",["{home}/.factory"],1],
 ["firebender","Firebender","{home}/.firebender/skills",["{home}/.firebender"],1],
 ["forgecode","ForgeCode","{home}/.forge/skills",["{home}/.forge"]],
 ["fx","fx","{home}/.fx/skills",["{home}/.fx"]],
 ["gemini-cli","Gemini CLI","{home}/.gemini/skills",["{home}/.gemini"],1],
 ["github-copilot","GitHub Copilot","{home}/.copilot/skills",["{home}/.copilot"],1],
 ["goose","Goose","{config}/goose/skills",["{config}/goose"]],
 ["grok","Grok Build","{grok}/skills",["{grok}"]],
 ["hermes-agent","Hermes Agent","{hermes}/skills",["{hermes}"]],
 ["inference-sh","inference.sh","{home}/.inferencesh/skills",["{home}/.inferencesh"]],
 ["jazz","Jazz","{home}/.jazz/skills",["{home}/.jazz","{cwd}/.jazz"]],
 ["junie","Junie","{home}/.junie/skills",["{home}/.junie"]],
 ["iflow-cli","iFlow CLI","{home}/.iflow/skills",["{home}/.iflow"]],
 ["kilo","Kilo Code","{home}/.kilo/skills",["{home}/.kilo","{home}/.kilocode"],1],
 ["kimchi","Kimchi","{home}/.config/kimchi/harness/skills",["{home}/.config/kimchi"]],
 ["kimi-code-cli","Kimi Code CLI","{home}/.agents/skills",["{home}/.kimi-code","{home}/.kimi"],1],
 ["kiro-cli","Kiro CLI","{home}/.kiro/skills",["{home}/.kiro"]],
 ["kode","Kode","{home}/.kode/skills",["{home}/.kode"]],
 ["lingma","Lingma","{home}/.lingma/skills",["{home}/.lingma"]],
 ["loaf","Loaf","{home}/.agents/skills",["{home}/.loaf"],1],
 ["mcpjam","MCPJam","{home}/.mcpjam/skills",["{home}/.mcpjam"]],
 ["minimax-code","MiniMax Code","{home}/.minimax/skills",["{home}/.minimax","/Applications/MiniMax Code.app"]],
 ["mistral-vibe","Mistral Vibe","{vibe}/skills",["{vibe}"]],
 ["moxby","Moxby","{home}/.moxby/skills",["{home}/.moxby"]],
 ["mux","Mux","{home}/.mux/skills",["{home}/.mux"]],
 ["opencode","OpenCode","{config}/opencode/skills",["{config}/opencode"],1],
 ["openhands","OpenHands","{home}/.openhands/skills",["{home}/.openhands"]],
 ["ona","Ona","{home}/.ona/skills",["{home}/.ona"]],
 ["pi","Pi","{home}/.pi/agent/skills",["{home}/.pi/agent"]],
 ["posit-assistant","Posit Assistant","{home}/.posit/assistant/skills",["{home}/.posit/assistant","{home}/.positai"]],
 ["qoder","Qoder","{home}/.qoder/skills",["{home}/.qoder"]],
 ["qoder-cn","Qoder CN","{home}/.qoder-cn/skills",["{home}/.qoder-cn"]],
 ["qwen-code","Qwen Code","{home}/.qwen/skills",["{home}/.qwen"]],
 ["replit","Replit","{config}/agents/skills",["{cwd}/.replit"],1],
 ["reasonix","Reasonix","{home}/.reasonix/skills",["{home}/.reasonix"]],
 ["rovodev","Rovo Dev","{home}/.rovodev/skills",["{home}/.rovodev"]],
 ["roo","Roo Code","{home}/.roo/skills",["{home}/.roo"]],
 ["sarvam-code","Sarvam Code","{home}/.agents/skills",["{sarvam}"],1],
 ["tabnine-cli","Tabnine CLI","{home}/.tabnine/agent/skills",["{home}/.tabnine"]],
 ["terramind","Terramind","{home}/.terramind/skills",["{home}/.terramind"]],
 ["tinycloud","Tinycloud","{home}/.tinycloud/skills",["{home}/.tinycloud"]],
 ["trae","Trae","{home}/.trae/skills",["{home}/.trae"]],
 ["trae-cn","Trae CN","{home}/.trae-cn/skills",["{home}/.trae-cn"]],
 ["warp","Warp","{home}/.agents/skills",["{home}/.warp"],1],
 ["windsurf","Windsurf","{home}/.codeium/windsurf/skills",["{home}/.codeium/windsurf"]],
 ["zed","Zed","{home}/.agents/skills",["{config}/zed","{appdata}/Zed","{flatpak}/zed"],1],
 ["zcode","ZCode","{home}/.zcode/skills",["{home}/.zcode","/Applications/ZCode.app"]],
 ["zencoder","Zencoder","{home}/.zencoder/skills",["{home}/.zencoder"]],
 ["zenflow","Zenflow","{home}/.zencoder/skills",["{home}/.zencoder"]],
 ["neovate","Neovate","{home}/.neovate/skills",["{home}/.neovate"]],
 ["pochi","Pochi","{home}/.pochi/skills",["{home}/.pochi"]],
 ["adal","AdaL","{home}/.adal/skills",["{home}/.adal"]],
 ["universal","Universal","{config}/agents/skills",[],1]
];
// 模板变量 → 本机路径。取不到值的变量（比如 macOS 上没有 APPDATA）解析为 null，调用方跳过该候选。
function variables({home,env={}}){
 const value=v=>typeof v==='string'&&v.trim()?v.trim():null;
 return {
  home,
  config:value(env.XDG_CONFIG_HOME)||home+'/.config',
  codex:value(env.CODEX_HOME)||home+'/.codex',
  claude:value(env.CLAUDE_CONFIG_DIR)||home+'/.claude',
  vibe:value(env.VIBE_HOME)||home+'/.vibe',
  hermes:value(env.HERMES_HOME)||home+'/.hermes',
  autohand:value(env.AUTOHAND_HOME)||home+'/.autohand',
  grok:value(env.GROK_HOME)||home+'/.grok',
  sarvam:value(env.SARVAM_HOME)||home+'/.sarvam',
  appdata:value(env.APPDATA),
  flatpak:value(env.FLATPAK_XDG_CONFIG_HOME),
  // 技能命令的工作目录就是用户主目录（原 CLI 行为），所以 {cwd} 按 home 算。
  cwd:home
 };
}
export function resolveAgentPath(template,vars){
 let broken=false;
 const out=template.replace(/\{(\w+)\}/g,(_,key)=>{const v=vars[key];if(v===undefined||v===null){broken=true;return '';}return v;});
 return broken?null:out;
}
// 本机的 Agent 列表：registry 里所有能解析出全局目录的 Agent（含未安装的）。
export function skillAgents({home,env}){
 const vars=variables({home,env}),out=[];
 for(const [id,name,dir,detect,universal] of AGENT_TABLE){
  const resolved=resolveAgentPath(dir,vars);if(!resolved)continue;
  const paths=[];for(const d of detect){const p=resolveAgentPath(d,vars);if(p&&!paths.includes(p))paths.push(p);}
  out.push({id,name,dir:resolved,detect:paths,universal:!!universal});
 }
 return out;
}
