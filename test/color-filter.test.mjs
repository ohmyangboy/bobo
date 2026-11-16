import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseColorFilterSnapshot,createColorFilter} from '../src/color-filter.mjs';

const filterSample=()=>({supported:true,available:true,enabled:true,type:1,intensity:0.9,intensityMin:0.25,intensityMax:1,hue:0,adjustable:true,reason:'调节会立刻作用到整块屏幕。'});

test('色彩滤镜页面：设备分栏里有开关、类型和按百分比显示的强度',async()=>{
 const html=await fs.readFile(new URL('../public/index.html',import.meta.url),'utf8');
 const device=html.slice(html.indexOf('id="deviceWorkspace"'),html.indexOf('id="settingsWorkspace"'));
 assert.match(device,/data-device-pane="color-filter"/);
 assert.match(device,/id="colorFilterIntensity"/);
 assert.match(device,/id="colorFilterIntensityValue"[^>]*>100%/);
 assert.doesNotMatch(device,/id="colorFilterIntensity"[\s\S]{0,180}<span>高<\/span>/);
 assert.match(device,/id="rowColorFilterHue" hidden/);
 assert.match(device,/id="deviceRefresh"/);
 const app=await fs.readFile(new URL('../public/app.js',import.meta.url),'utf8');
 assert.match(app,/commitColorFilter\(\{type:Number/);
 assert.doesNotMatch(app,/color-filter',\{type:[^}]*enabled/);
});

test('色彩滤镜快照与命令：隔离环境不调用，参数按类型、色调、强度、开关',async()=>{
 assert.equal(parseColorFilterSnapshot(JSON.stringify(filterSample())).type,1);
 for(const bad of [{...filterSample(),type:3},{...filterSample(),supported:false},{...filterSample(),hue:1.2},{...filterSample(),intensityMin:1,intensityMax:0.25},{...filterSample(),reason:1}])assert.throws(()=>parseColorFilterSnapshot(JSON.stringify(bad)));
 const calls=[];
 const isolated=createColorFilter({platform:'darwin',argv1:'/Applications/bobo.app/Contents/MacOS/Bobo',isolated:true,exec:async()=>{calls.push('isolated');return JSON.stringify(filterSample());}});
 assert.equal((await createColorFilter({platform:'darwin',argv1:'/Applications/bobo.app/Contents/MacOS/Bobo',isolated:true}).snapshot()).supported,false);
 await assert.rejects(createColorFilter({platform:'darwin',argv1:'/Applications/bobo.app/Contents/MacOS/Bobo',isolated:true}).save({enabled:true}),error=>error.status===400);
 assert.equal((await isolated.snapshot()).supported,true,'注入的命令仍可在隔离环境里验证参数');
 const exec=async(file,args)=>{calls.push([file,args]);return JSON.stringify({...filterSample(),enabled:args.includes('true')});};
 const live=createColorFilter({platform:'darwin',argv1:'/Applications/Bobo.app/Contents/MacOS/Bobo',isolated:false,exec});
 assert.equal((await live.snapshot()).supported,true);
 assert.deepEqual(calls.at(-1),['/Applications/Bobo.app/Contents/MacOS/Bobo',['--color-filter','status']]);
 await live.save({type:16,intensity:0.5,hue:0.2,enabled:false});
 assert.deepEqual(calls.at(-1)[1],['--color-filter','apply','type','16','hue','0.2','intensity','0.5','enabled','false']);
 await assert.rejects(live.save({type:3}),error=>error.status===400&&/不支持/.test(error.message));
 await assert.rejects(live.save({intensity:2}),error=>error.status===400);
 await assert.rejects(live.save({enabled:'true'}),error=>error.status===400);
 await assert.rejects(live.save({extra:1}),error=>error.status===400);
 await assert.rejects(live.save({}),error=>error.status===400);
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const slow=createColorFilter({platform:'darwin',argv1:'/Applications/Bobo.app/Contents/MacOS/Bobo',isolated:true,exec:async()=>{await gate;return JSON.stringify(filterSample());}});
 const pending=slow.save({enabled:true});
 await assert.rejects(slow.save({intensity:0.5}),error=>error.status===409);
 release();await pending;
 const broken=createColorFilter({platform:'darwin',argv1:'/Applications/Bobo.app/Contents/MacOS/Bobo',exec:async()=>{throw Error('boom');}});
 await assert.rejects(broken.snapshot(),/无法读取系统色彩滤镜/);
 await assert.rejects(broken.save({enabled:true}),error=>/色彩滤镜操作失败/.test(error.message)&&error.status===undefined);
 assert.equal((await createColorFilter({platform:'linux',argv1:'/Applications/Bobo.app/Contents/MacOS/Bobo',isolated:false,exec}).snapshot()).supported,false);
});

test('色彩滤镜：只切换开关，没选过类型时才写成灰度', {skip:process.platform!=='darwin'}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bobo-color-filter-'));
  const main = path.join(dir, 'main.swift');
  const binary = path.join(dir, 'check');
  try {
    await fs.writeFile(main, `
import Foundation
final class Probe {
    var enabled = false
    var type: Int32 = 0
    var intensity = 0.5
    var hue = 0.2
    var stick = true
    var events: [String] = []
    func symbols() -> ColorFilterSymbols {
        ColorFilterSymbols(
            getEnabled: { [self] _ in self.enabled },
            setEnabled: { [self] _, on in self.events.append(on ? "on" : "off"); if self.stick { self.enabled = on } },
            getType: { [self] _ in self.type },
            setType: { [self] _, type in self.events.append("type\\(type)"); self.type = type },
            wake: { [self] magic in self.events.append("wake\\(magic)") },
            getIntensity: { [self] _ in self.intensity },
            setIntensity: { [self] _, value in self.events.append("intensity"); self.intensity = value },
            intensityRange: { _ in (0.25, 1) },
            getHue: { [self] in self.hue },
            setHue: { [self] value in self.events.append("hue"); self.hue = value },
            adjustable: true)
    }
}
let probe = Probe()
let filter = ColorFilterController(symbols: probe.symbols())
precondition(filter.available && !filter.enabled)
filter.toggle()
precondition(filter.enabled && filter.error == nil)
precondition(probe.events == ["type1", "on", "wake8"] && probe.type == 1, "没选过滤镜时先设灰度再打开")
probe.events = []
probe.type = 4
filter.toggle()
precondition(!filter.enabled && probe.events == ["off", "wake8"] && probe.type == 4, "关掉时保留原来的类型")
filter.toggle()
precondition(filter.enabled && probe.events == ["off", "wake8", "on", "wake8"] && probe.type == 4, "已有类型时只打开")
probe.stick = false
probe.enabled = false
filter.toggle()
precondition(!filter.enabled && filter.error == "色彩滤镜没有切换成功")
probe.stick = true
probe.enabled = false
probe.type = 1
probe.events = []
filter.select(4)
precondition(filter.enabled && filter.type == 4 && probe.events == ["type4", "on", "wake8"], "选择滤镜时从关闭改为打开")
probe.events = []
filter.select(ColorFilterKind.tint.rawValue)
precondition(filter.type == 16 && probe.events == ["type16", "wake8"], "已经打开时只换类型")
filter.select(3)
precondition(filter.error == "不支持的色彩滤镜" && filter.type == 16)
probe.events = []
filter.setIntensity(2)
precondition(probe.intensity == 1 && probe.events == ["intensity", "wake8"], "强度钳在滤镜自己的范围内")
probe.events = []
filter.setIntensity(1)
precondition(probe.events.isEmpty, "强度没变就不写偏好")
probe.events = []
filter.setHue(1.5)
precondition(probe.hue == 1 && probe.events == ["hue", "wake8"])
probe.type = 1
filter.refresh()
probe.events = []
filter.setHue(0)
precondition(probe.events.isEmpty && probe.hue == 1, "只有色调滤镜才改色调")
probe.events = []
probe.enabled = false
probe.type = 4
filter.refresh()
filter.setEnabled(true)
precondition(filter.enabled && probe.type == 4 && probe.events == ["on", "wake8"], "已有类型时只打开")
probe.events = []
probe.enabled = false
probe.type = 0
filter.refresh()
filter.setEnabled(true)
precondition(filter.enabled && probe.type == 1 && probe.events == ["type1", "on", "wake8"], "没选过类型时打开才写成灰度")
probe.events = []
filter.setEnabled(true)
precondition(probe.events.isEmpty, "开关没变就不写偏好")
probe.events = []
probe.enabled = false
filter.refresh()
filter.setType(8)
precondition(!filter.enabled && filter.type == 8 && probe.events == ["type8", "wake8"], "改类型不打开滤镜")
filter.setType(3)
precondition(filter.error == "不支持的色彩滤镜" && filter.type == 8)
let status = try ColorFilterCommand.apply(["status"], filter: filter)
precondition(status.supported && status.type == 8 && !status.enabled)
probe.events = []
probe.enabled = true
filter.refresh()
_ = try ColorFilterCommand.apply(["apply", "type", "2", "intensity", "0.4"], filter: filter)
precondition(probe.type == 2 && probe.intensity == 0.4 && !probe.events.contains("on"), "命令改类型和强度时不重复打开")
do {
    _ = try ColorFilterCommand.apply(["apply", "hue", "0.3"], filter: filter)
    preconditionFailure("色调不该写到非色调滤镜")
} catch {
    precondition(error.localizedDescription == "只有色调滤镜可以调节色调")
}
probe.events = []
_ = try ColorFilterCommand.apply(["apply", "type", "16", "hue", "0.3", "enabled", "false"], filter: filter)
precondition(probe.type == 16 && probe.hue == 0.3 && !probe.enabled)
do {
    _ = try ColorFilterCommand.apply(["apply", "type", "3"], filter: filter)
    preconditionFailure("非法类型不该写入")
} catch {
    precondition(error.localizedDescription == "不支持的色彩滤镜")
}
precondition(probe.type == 16)
do {
    _ = try ColorFilterCommand.apply(["nope"], filter: filter)
    preconditionFailure("非法命令不该成功")
} catch {
    precondition(error.localizedDescription == "色彩滤镜参数无效")
}
let missing = ColorFilterController(symbols: nil)
missing.toggle()
precondition(!missing.available && missing.error == "色彩滤镜不可用")
guard ColorFilterSymbols.load() != nil else { fatalError("本机没有色彩滤镜符号") }
let live = ColorFilterController.system()
precondition(live.available && live.adjustable)
_ = live.enabled
_ = live.type
_ = live.intensity
_ = live.hue
print("色彩滤镜验证通过")
`);
    execFileSync('/usr/bin/xcrun', ['swiftc', fileURLToPath(new URL('../macos/ColorFilter.swift', import.meta.url)), main, '-o', binary], {stdio:'pipe', timeout:90000});
    const out = execFileSync(binary, {encoding:'utf8', timeout:10000});
    assert.match(out, /色彩滤镜验证通过/);
  } finally {
    await fs.rm(dir, {recursive:true, force:true});
  }
});
