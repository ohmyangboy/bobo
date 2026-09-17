import fs from 'node:fs/promises';
import path from 'node:path';

// 备份目录按 `<ISO 时间>-<操作>` 命名，名称可直接按字符串排序（即时间顺序）。
// 保留最近 limit 份，超出时淘汰最旧的；技能与智能体的备份共用同一个目录与配额。
export async function pruneBackups(root,limit=3){
 const items=await fs.readdir(root,{withFileTypes:true}).catch(()=>[]);
 const dirs=items.filter(e=>e.isDirectory()).map(e=>e.name).sort();
 for(const name of dirs.slice(0,Math.max(0,dirs.length-limit)))await fs.rm(path.join(root,name),{recursive:true,force:true});
}
