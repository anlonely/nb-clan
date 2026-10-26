import test from 'node:test';
import assert from 'node:assert/strict';
import { exportDocument } from '../server/v2/stats/exports.js';
test('member CSV contains projected fields with CSV formula escaping and no raw extras', () => {
  const doc = exportDocument({wipe:{id:'query',title:'Public member'},sourceId:'member',items:[],queryResult:{
    steamId:'76561198000000001',displayName:'=HYPERLINK("bad")',status:'fresh',
    fields:[{name:'公开字段',value:'line1, "quoted"\nline2',status:'observed'}],raw:{phone:'secret-phone'},phone:'secret-phone'
  }},{language:'zh'});
  assert.ok(doc.csv.includes('76561198000000001'));
  assert.ok(doc.csv.includes(`"'=HYPERLINK(""bad"")"`));
  assert.ok(doc.csv.includes('"line1, ""quoted""\nline2"'));
  assert.equal(doc.csv.includes('secret-phone'),false);
  assert.ok(doc.csv.includes('"字段","值","状态"'));
});
