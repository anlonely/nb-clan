import { chromiumExecutablePath } from '../../../server/chromium-runtime.js';
import '../results.mjs';
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
const metadata=JSON.parse(await readFile(process.argv[2],'utf8')),origin=metadata.origin;assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
const out='output/test-results/g07-platforms',browser=await puppeteer.launch({executablePath:chromiumExecutablePath(),headless:true,args:['--disable-background-networking','--no-first-run']});
const page=await browser.newPage(),errors=[],requests=[],checks=[];await page.setViewport({width:1440,height:1000});await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(origin)||r.url().startsWith('data:')||r.url().startsWith('blob:')?r.continue():r.abort());page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.url().includes('/api/'))requests.push({path:new URL(r.url()).pathname,status:r.status()});});
const waitText=text=>page.waitForFunction(t=>document.body.innerText.includes(t),{},text);
const click=async label=>{await page.waitForFunction(t=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===t&&!b.disabled),{},label);return page.evaluate(t=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);if(!b)throw new Error('Missing '+t);b.click();},label);};
const shot=name=>page.screenshot({path:`${out}/${name}-1440.png`,fullPage:true});
const control=async body=>{const r=await fetch(origin+'/__control',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','x-platform-control':metadata.controlToken},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();};
async function field(label,value){const sel=`input[aria-label="${label}"]`;await page.waitForSelector(sel);await page.$eval(sel,e=>{e.focus();e.select();});await page.type(sel,value);}
async function login(key='admin'){await page.goto(origin+'/admin/platforms/discord',{waitUntil:'networkidle0'});await page.click('a[href^="/api/v2/auth/discord/start"]');await page.waitForSelector(`[data-fixture="${key}"]`);await page.click(`[data-fixture="${key}"]`);await waitText('平台接入');}
try{
 await login();await waitText('Discord 配置');await shot('discord');checks.push('real-G03-OAuth-session');
 await field('应用 ID','fixture_application');await click('保存配置');await waitText('操作已完成');checks.push('configuration-write-and-reread');
 await page.select('select[aria-label="动作"]','register_commands');await click('执行所选动作');await waitText('registered_fixture');await shot('commands');checks.push('explicit-command-registration');
 await page.select('select[aria-label="动作"]','card_preview');await field('targetId','discord-local');await field('wipeId','g07_active');await click('执行所选动作');await waitText('击杀 /');await shot('card-preview');checks.push('real-stats-preview');
 await page.select('select[aria-label="动作"]','card_publish');await click('执行所选动作');await waitText('卡片已发布');checks.push('G06-isolated-native-send');
 await page.select('select[aria-label="动作"]','card_refresh');await click('执行所选动作');await waitText('原卡已更新');checks.push('G06-original-card-edit');
 await page.click('nav[aria-label="平台"] a[href$="/bridge"]');await waitText('消息转发 配置');await click('执行所选动作');await waitText('成功 1');await shot('bridge');checks.push('forwarding-translation');
 await click('执行所选动作');await waitText('跳过 1');checks.push('forward-deduplication');
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='执行所选动作'&&!b.disabled));await page.setOfflineMode(true);await click('重新读取');await waitText('显示上次读取的数据');await shot('offline');await page.setOfflineMode(false);await click('重新读取');await page.waitForFunction(()=>!document.body.innerText.includes('显示上次读取的数据'));checks.push('offline-and-recovery');
 await page.click('nav[aria-label="平台"] a[href$="/wechat"]');await waitText('小程序与网站微信登录分别管理');await shot('wechat');checks.push('mini-website-independent-state');
 await page.select('select[aria-label="动作"]','sync');await field('memberId','g05_alpha');await click('执行所选动作');await waitText('此动作尚未连接执行服务');await shot('adapter-missing');checks.push('missing-adapter-explicit-failure');
 await page.click('nav[aria-label="平台"] a[href$="/discord"]');await waitText('Discord 配置');await control({action:'disconnect-after'});await field('应用 ID','fixture_application_changed');await click('保存配置');await waitText('请查询回执');await click('查询回执');await waitText('已核实：上次操作成功');await shot('response-lost-recovered');checks.push('committed-response-lost-receipt-recovery');
 await control({action:'revoke'});await waitText('管理空间隔离登录');await shot('revoked');checks.push('live-G03-revocation-clears-screen');
 await login('alpha');await waitText('暂时无法读取');await shot('permission-denied');checks.push('member-platform-permission-denied');
 assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>1440),false);await writeFile(`${out}/browser.json`,JSON.stringify({origin,viewport:{width:1440,height:1000},browser:await browser.version(),fixtureData:true,realExternalAuth:false,checks,errors,requests},null,2));console.log(JSON.stringify({passed:true,checks,errors}));
}catch(e){await shot('failure');await writeFile(`${out}/browser-failure.json`,JSON.stringify({error:e.message,checks,errors,requests},null,2));throw e;}finally{await browser.close();}
