import '../results.mjs';
// Keep prior goal reports immutable while executing their original assertions.
import '../v2-source-main/offline.mjs';
import { registerHooks } from 'node:module';
const rules=new Map([
 [new URL('../../../test/v2-source-providers.test.js',import.meta.url).href,[['../output/test-results/g07-source-providers/','../output/test-results/g07-provider-projection/provider-regression/']]],
 [new URL('../../../test/v2-risk-collector.test.js',import.meta.url).href,[['test/support/v2-risk-collector/run.mjs','test/support/v2-provider-projection/risk-regression.mjs'],['../output/test-results/g07-risk-collector/runtime-report.json','../output/test-results/g07-provider-projection/risk-regression/runtime-report.json'],['../test/support/v2-risk-collector/.runtime/','../test/support/v2-provider-projection/.runtime-risk/']]]
]);
registerHooks({load(url,context,next){const out=next(url,context),replacements=rules.get(url);if(!replacements)return out;let source=String(out.source);for(const [before,after] of replacements){if(source.split(before).length!==2)throw new Error('Protected report redirection no longer matches');source=source.replace(before,after);}return {...out,source};}});
