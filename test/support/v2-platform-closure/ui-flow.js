import '../results.mjs';
async page=>{
 await page.setViewportSize({width:1440,height:1000});
 const check=(ok,label)=>{if(!ok)throw new Error(label);};
 await page.getByLabel('应用 ID',{exact:true}).fill('unsaved-fixture');
 await page.getByLabel('新凭据',{exact:true}).fill('constructed-secret');
 const checks=[];
 for(const state of ['failed','cancelled','skipped','queued','running','result_unknown']){
  await page.getByLabel('steamId',{exact:true}).fill(state);
  await page.getByRole('button',{name:'执行所选动作',exact:true}).click();
  await page.locator('.platform-result strong').filter({hasText:state==='result_unknown'?'投递结果未知':state}).waitFor();
  const terminal=['failed','cancelled','skipped'].includes(state);
  check(await page.getByRole('button',{name:'查询回执',exact:true}).count()===(terminal?0:1),'operation ID lifetime '+state);
  if(!terminal){
   const before=await page.evaluate(()=>window.uiFixture.calls.at(-1).id);
   await page.getByRole('button',{name:'重试同次操作',exact:true}).click();
   await page.getByRole('button',{name:'执行所选动作',exact:true}).isEnabled();
   check(await page.evaluate(()=>window.uiFixture.calls.at(-1).id)===before,'replay ID '+state);
   await page.evaluate(s=>{window.uiFixture.receiptState=s;},state==='queued'?'failed':state==='running'?'cancelled':'skipped');
   await page.getByRole('button',{name:'查询回执',exact:true}).click();
   await page.getByRole('button',{name:'查询回执',exact:true}).waitFor({state:'detached'});
  }
  check(await page.getByLabel('应用 ID',{exact:true}).inputValue()==='unsaved-fixture','preserved config '+state);
  check(await page.getByLabel('新凭据',{exact:true}).inputValue()==='constructed-secret','preserved secret '+state);
  check(await page.getByLabel('steamId',{exact:true}).inputValue()===state,'preserved query '+state);
  checks.push(state);
 }
 await page.getByLabel('steamId',{exact:true}).fill('failed');await page.getByRole('button',{name:'执行所选动作',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'操作失败，输入已保留'}).waitFor();
 await page.screenshot({path:'output/test-results/g07-platform-closure/desktop-terminal.png',fullPage:true});
 const ids=await page.evaluate(()=>window.uiFixture.calls.map(x=>x.id));
 check(new Set(ids).size===7,'terminal failure permits new operation ID');
 console.log(JSON.stringify({passed:true,checks,operationIds:ids,viewport:{width:1440,height:1000},realReactComponent:true,responseFixture:true,externalIO:false}));
}
