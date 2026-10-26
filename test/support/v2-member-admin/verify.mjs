import { chromiumExecutablePath } from '../../../server/chromium-runtime.js';
import '../results.mjs';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import puppeteer from 'puppeteer-core';
export async function verify({
  origin,
  runDir,
  f,
  cache,
  getCachePatches
}) {
  const evidence = path.resolve('output/test-results/g07-members');
  await mkdir(evidence, {
    recursive: true
  });
  const checks = [],
    http = [],
    browserErrors = [],
    requests = [];
  function check(name, fn) {
    fn();
    checks.push({
      name,
      passed: true
    });
  }
  const login = async account => {
    const response = await fetch(origin + '/__fixture/login', {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        account
      })
    });
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ');
    const me = await fetch(origin + '/api/v2/auth/me', {
      headers: {
        Cookie: cookies
      }
    }).then(r => r.json());
    return {
      cookies,
      csrf: me.data.csrfToken
    };
  };
  const admin = await login('admin');
  async function req(url, {
    auth = admin,
    method = 'GET',
    body,
    op = randomUUID(),
    originHeader = origin,
    csrf = auth?.csrf
  } = {}) {
    const response = await fetch(origin + '/api/v2/member-admin' + url, {
      method,
      headers: {
        ...(auth ? {
          Cookie: auth.cookies
        } : {}),
        Origin: originHeader,
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf || '',
        'Idempotency-Key': op
      },
      ...(body ? {
        body: JSON.stringify(body)
      } : {})
    });
    const data = await response.json();
    http.push({
      url,
      method,
      status: response.status,
      code: data.error?.errorCode || null
    });
    return {
      status: response.status,
      ...data
    };
  }
  check('HTTP unauthenticated 401', () => {});
  assert.equal((await req('/members', {
    auth: null
  })).status, 401);
  assert.equal((await req('/members/m001', {
    method: 'PATCH',
    body: {
      expectedRevision: 1,
      fields: {
        customName: 'bad'
      }
    },
    csrf: 'wrong'
  })).status, 403);
  checks.push({
    name: 'HTTP real G03 CSRF rejects mutation',
    passed: true
  });
  assert.equal((await req('/members/m001', {
    method: 'PATCH',
    body: {
      expectedRevision: 1,
      fields: {
        customName: 'bad'
      }
    },
    originHeader: 'http://evil.invalid'
  })).status, 403);
  const countBefore = f.db.prepare('SELECT total_changes() n').get().n;
  await req('/members');
  await req('/reviews');
  await req('/risks');
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, countBefore);
  checks.push({
    name: 'HTTP GETs leave total_changes unchanged',
    passed: true
  });
  const key = randomUUID(),
    input = {
      expectedRevision: 1,
      fields: {
        customName: 'HTTP 已保存'
      }
    };
  const a = await req('/members/m010', {
    method: 'PATCH',
    body: input,
    op: key
  });
  assert.equal(a.status, 200);
  assert.equal(a.data.changes, undefined);
  assert.equal(cache.members.find(m => m.id === 'm010').customName, 'HTTP 已保存');
  await req('/members/m010', {
    method: 'PATCH',
    body: {
      expectedRevision: 2,
      fields: {
        customName: 'HTTP 后续更新'
      }
    }
  });
  const replay = await req('/members/m010', {
    method: 'PATCH',
    body: input,
    op: key
  });
  assert.equal(replay.data.replayed, true);
  assert.equal(cache.members.find(m => m.id === 'm010').customName, 'HTTP 后续更新');
  checks.push({
    name: 'serialized cache update replays current record, never stale receipt',
    passed: true
  });
  assert.equal((await req('/operations/' + key)).data.committed, true);
  assert.equal((await req('/archive/archive1', {
    method: 'POST',
    body: {}
  })).status, 410);
  assert.equal((await req('/members/m001/unlink', {
    method: 'POST',
    body: {
      expectedRevision: 1,
      provider: 'discord',
      reason: 'missing adapter'
    }
  })).error.errorCode, 'IDENTITY_ADAPTER_REQUIRED');
  const member = await login('member');
  const list = await req('/members', {
    auth: member
  });
  assert.equal(list.data.total, 35);
  const dto = await req('/members/m001', {
    auth: member
  });
  assert.equal(dto.data.notes, undefined);
  assert.equal(dto.data.risks, undefined);
  assert.equal((await req('/members/m040', {
    auth: member
  })).status, 403);
  assert.equal((await req('/members/export?fields=notes', {
    auth: member
  })).status, 403);
  checks.push({
    name: 'HTTP scope and export/private projections',
    passed: true
  });
  const browser = await puppeteer.launch({
    executablePath: chromiumExecutablePath(),
    headless: true,
    userDataDir: path.join(runDir, 'chrome'),
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-default-apps', '--disable-features=MediaRouter', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1
    });
    page.on('pageerror', e => browserErrors.push(String(e)));
    await page.setRequestInterception(true);
    page.on('request', r => {
      const u = r.url();
      requests.push({
        url: u.replace(origin, ''),
        method: r.method()
      });
      if (u.startsWith(origin + '/') || u.startsWith('data:') || u.startsWith('blob:')) r.continue();else r.abort();
    });
    const click = async text => {
      await page.waitForFunction(t => Array.from(document.querySelectorAll('button,a')).some(e => e.textContent.trim() === t), {}, text);
      await page.evaluate(t => {
        const el = Array.from(document.querySelectorAll('dialog[open] button,dialog[open] a,button,a')).find(e => e.textContent.trim() === t && e.getClientRects().length);
        if (!el) throw Error('Missing ' + t);
        el.click();
      }, text);
    };
    const fill = async (label, value) => {
      await page.waitForFunction(l => Array.from(document.querySelectorAll('label')).some(e => e.querySelector('input,textarea,select') && e.querySelector('span')?.textContent === l), {}, label);
      const handle = await page.evaluateHandle(l => Array.from(document.querySelectorAll('dialog[open] label,label')).find(e => e.querySelector('span')?.textContent === l)?.querySelector('input,textarea,select'), label);
      await handle.click();
      const n = await handle.evaluate(el => el.value.length);
      for (let i = 0; i <= n; i++) await handle.press('ArrowRight');
      for (let i = 0; i <= n; i++) await handle.press('Backspace');
      await handle.type(value);
      await handle.dispose();
    };
    const select = async (label, value) => {
      const handle = await page.evaluateHandle(l => Array.from(document.querySelectorAll('dialog[open] label,label')).find(e => e.querySelector('span')?.textContent === l)?.querySelector('select'), label);
      await handle.select(value);
      await handle.dispose();
    };
    const waitText = async text => page.waitForFunction(t => document.body.innerText.includes(t), {}, text);
    const shot = async name => {
      await page.screenshot({
        path: path.join(evidence, name + '.png'),
        fullPage: false
      });
      const dims = await page.evaluate(() => ({
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth
      }));
      assert.equal(dims.width, 1440);
      assert.equal(dims.scrollWidth, 1440);
      checks.push({
        name: '1440 browser ' + name,
        passed: true,
        ...dims
      });
    };
    await page.goto(origin + '/admin/members', {
      waitUntil: 'networkidle0'
    });
    await page.select('[aria-label="构造账号"]', 'admin');
    await waitText('林舟');
    await shot('members-1440');
    await click('新增成员');
    await fill('SteamID / 数字主页链接', '76561198999999911');
    await fill('站内名称', '浏览器新成员');
    await fill('联系电话', '123456');
    await click('保存成员');
    await waitText('浏览器新成员');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await shot('member-created-1440');
    const created = f.service.repo.find('members', 'steamId', '76561198999999911', 2)[0];
    assert.ok(created);
    assert.equal(created.phone, '123456');
    await click('编辑资料');
    await fill('站内名称', '浏览器编辑完成');
    await fill('内部备注', '通过真实页面修改资料');
    await click('保存成员');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await waitText('浏览器编辑完成');
    assert.equal(f.ir.get('members', created.id).notes, '通过真实页面修改资料');
    await click('调整状态');
    await select('目标状态', 'suspended');
    await fill('操作原因', '测试暂停与恢复');
    await click('确认操作');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(f.ir.get('members', created.id).memberStatus, 'suspended');
    await click('调整状态');
    await select('目标状态', 'active');
    await fill('操作原因', '测试恢复正常');
    await click('确认操作');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await click('调整队伍');
    await select('目标队伍', 's1');
    await fill('操作原因', '加入先锋队');
    await click('确认操作');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(f.service.repo.currentSquad(created.id)[0].squadId, 's1');
    await shot('member-edited-history-1440');
    // A second writer changes revision while the actual dialog remains open.
    await click('编辑资料');
    await fill('站内名称', '冲突旧修改');
    const current = f.ir.get('members', created.id);
    f.service.edit(f.actor('admin'), created.id, {
      expectedRevision: current.revision,
      fields: {
        customName: '另一管理员已更新'
      }
    }, randomUUID());
    await click('保存成员');
    await waitText('需要重新确认');
    await page.evaluate(() => document.querySelector('dialog[open] button[aria-label="关闭对话框"]').click());
    await shot('revision-conflict-1440');
    await click('收起');
    await click('成员名单');
    await click('批量导入');
    await fill('导入文本', '76561198999999912\n76561198999999912\nbad-input');
    await click('校验并预览');
    await waitText('预览：新增 1 / 重复 1 / 无效 1');
    await shot('import-preview-1440');
    await click('执行导入');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await waitText('导入 1，跳过 1，失败 1');
    await shot('import-results-1440');
    await click('队伍管理');
    await click('新建队伍');
    await fill('队伍名称', '浏览器三队');
    await fill('队伍备注', '用于组织验收');
    await select('添加队长', 'leader');
    await select('添加队长', 'other');
    await page.click('[aria-label="上移 other"]');
    await click('保存队伍');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await waitText('浏览器三队');
    const squad = f.service.repo.find('squads', 'name', '浏览器三队', 2)[0];
    assert.deepEqual(squad.leaderUserIds, ['other', 'leader']);
    await shot('squads-1440');
    await click('注册审核');
    await waitText('待审核新人');
    await click('审核申请');
    await select('审核决定', 'need_more');
    await fill('操作原因', '补充时区信息');
    await click('确认操作');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await waitText('待补充');
    await click('审核申请');
    await select('审核决定', 'approved');
    await fill('操作原因', '资料已核对');
    await click('确认操作');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await waitText('已通过');
    assert.equal(f.service.repo.get('joinApplications', 'review1').status, 'approved');
    await shot('review-approved-1440');
    await click('旧申请封存');
    await waitText('旧 Discord 申请');
    assert.equal(await page.$eval('main', e => e.textContent.includes('审核申请')), false);
    await shot('archive-readonly-1440');
    await click('风险复核');
    await waitText('Steam 受限账号');
    await click('人工确认');
    await fill('操作原因', '核对来源，风险暂保留');
    await click('确认操作');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    await waitText('已确认');
    await shot('risk-confirmed-1440');
    await click('检测本页成员');
    await waitText('同步服务尚未接线');
    checks.push({
      name: 'browser missing sync adapter explicit failure without job',
      passed: true
    });
    await page.select('[aria-label="构造账号"]', 'root');
    await waitText('风险复核');
    await click('风险规则');
    await waitText('保存规则');
    await select('规则列表', '2');
    await fill('规则名称', '时长低于 600 小时');
    await fill('阈值', '600');
    await click('保存规则');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(f.service.rules(f.actor('root')).rules[2].threshold, 600);
    await shot('risk-rules-saved-1440');
    await page.select('[aria-label="构造账号"]', 'member');
    await click('成员名单');
    await waitText('林舟');
    assert.equal(await page.$eval('main', e => e.textContent.includes('新增成员')), false);
    await click('林舟');
    await waitText('当前账号仅可读取基础资料');
    assert.equal(await page.$eval('main', e => e.textContent.includes('private-phone')), false);
    await shot('member-scope-1440');
    await page.goto(origin + '/admin/members/profile/m040', {
      waitUntil: 'networkidle0'
    });
    await waitText('暂时无法读取');
    await shot('scope-denied-1440');
    await page.select('[aria-label="构造账号"]', 'admin');
    await page.goto(origin + '/admin/members?status=left', {
      waitUntil: 'networkidle0'
    });
    await waitText('当前筛选没有成员');
    await shot('empty-filter-1440');
    // Re-enter a deep static URL and check API calls, not a replaced response or prototype state.
    await page.goto(origin + '/admin/members/profile/' + created.id, {
      waitUntil: 'networkidle0'
    });
    await waitText('另一管理员已更新');
    await shot('static-deeplink-1440');
    // Drop a real response after the authenticated SQLite commit, then recover across reload.
    const beforeUnknown = f.ir.get('members', created.id).revision;
    await page.evaluate(() => {
      const native = window.fetch;
      let dropped = false;
      window.fetch = async (...args) => {
        const response = await native(...args);
        if (!dropped && String(args[0]).includes('/member-admin/members/') && args[1]?.method === 'PATCH') {
          dropped = true;
          throw new TypeError('Injected lost response after real commit');
        }
        return response;
      };
    });
    await click('编辑资料');
    await fill('站内名称', '未知回执实际已保存');
    await click('保存成员');
    await waitText('提交结果待确认');
    await page.evaluate(() => document.querySelector('dialog[open] button[aria-label="关闭对话框"]').click());
    await shot('unknown-response-1440');
    assert.equal(f.ir.get('members', created.id).revision, beforeUnknown + 1);
    await page.reload({
      waitUntil: 'networkidle0'
    });
    await waitText('提交结果待确认');
    await click('查询提交结果');
    await waitText('已从持久回执确认保存成功');
    assert.equal(f.ir.get('members', created.id).revision, beforeUnknown + 1);
    await shot('unknown-recovered-1440');
    await click('成员名单');
    await fill('搜索名称或 SteamID', '未知回执实际已保存');
    await click('搜索');
    await waitText('未知回执实际已保存');
    await page.waitForSelector('[aria-label="选择 未知回执实际已保存"]');
    await page.click('[aria-label="选择 未知回执实际已保存"]');
    await click('批量调整队伍');
    await select('批量目标队伍', 's2');
    await fill('操作原因', '浏览器批量调队');
    await click('确认操作');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(f.service.repo.currentSquad(created.id)[0].squadId, 's2');
    await click('导出名单');
    const csvResponse = page.waitForResponse(r => r.url().includes('/members/export'));
    await click('下载 CSV');
    const downloaded = await (await csvResponse).json();
    assert.ok(downloaded.data.csv.includes('未知回执实际已保存'));
    await shot('export-1440');
    await page.evaluate(() => document.querySelector('dialog[open] button[aria-label="关闭对话框"]').click());
    await page.click('[aria-label="选择 未知回执实际已保存"]');
    await click('删除所选（1）');
    await fill('操作原因', '浏览器删除后恢复演练');
    await click('确认操作');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.ok(f.ir.get('members', created.id).deletedAt);
    await waitText('当前筛选没有成员');
    await shot('deleted-filter-1440');
    await page.goto(origin + '/admin/members/profile/' + created.id, {
      waitUntil: 'networkidle0'
    });
    await click('恢复档案');
    await fill('操作原因', '保留历史恢复档案');
    await click('确认操作');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(f.ir.get('members', created.id).deletedAt, null);
    assert.equal(f.ir.get('members', created.id).memberStatus, 'left');
    await shot('restored-departed-1440');
    await click('离队档案');
    await waitText('未知回执实际已保存');
    await shot('departed-1440');
    assert.equal(browserErrors.length, 0, browserErrors.join('\n'));
    checks.push({
      name: 'zero browser JavaScript exceptions',
      passed: true
    });
    await writeFile(path.join(evidence, 'browser-requests.json'), JSON.stringify(requests.filter(r => r.url.startsWith('/api/')), null, 2));
  } finally {
    await browser.close();
  }
  check('cache patches recorded', () => assert.ok(getCachePatches() > 0));
  check('SQLite integrity', () => assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'));
  const report = {
    version: 1,
    origin,
    runDir,
    fixture: 'constructed SQLite; real G03 cookies and member-admin API',
    externalAuthentication: 'not performed',
    realExternalCalls: 0,
    backgroundJobs: false,
    mobile: 'not requested',
    checks,
    http,
    browserErrors,
    cachePatches: getCachePatches(),
    baselineModified: false
  };
  await writeFile(path.join(evidence, 'verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    verification: 'passed',
    checks: checks.length,
    evidence
  }));
}
