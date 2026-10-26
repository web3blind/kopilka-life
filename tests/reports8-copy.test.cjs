const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const root=path.resolve(process.env.REPORTS8_SOURCE||path.join(__dirname,'..'));process.chdir(root);
const ctx={window:{}};vm.runInNewContext(fs.readFileSync(path.join(root,'public/i18n.js'),'utf8'),ctx);
const {t}=ctx.window.KopilkaI18n;
const {landingHtml}=require(path.join(root,'src/services/landingHtmlService'));
for(const region of ['ru','global'])for(const vk of [false,true])for(const locale of ['ru','en'])test(`footer ${region} ${vk} ${locale}`,()=>{
 const html=landingHtml(region,{vk,locale});const footer=html.match(/<p class="soft-note legal-links">([\s\S]*?)<\/p>/)[1];
 const links=[...footer.matchAll(/<a ([^>]+)>([^<]+)<\/a>/g)];
 assert.equal(links.length,5);assert.deepEqual(links.map(m=>m[1].match(/href="([^"]+)/)[1]),['/about','/partners','/privacy.html','/terms.html','https://vk.ru/life_harbor_game']);
 assert.equal(links[0][2],locale==='ru'?'О сервисе':'About');assert.equal(links[1][2],locale==='ru'?'Партнёрам':'Partnerships');
 assert.match(links[0][1],/data-i18n="legalAbout"/);assert.match(links[1][1],/data-i18n="legalPartners"/);
 assert.equal(t(locale,'legalAbout'),links[0][2]);assert.equal(t(locale,'legalPartners'),links[1][2]);
});
test('informal referral disclosure preserves every fact and English',()=>{
 const ru='Получатель ссылки также сможет посмотреть твой публичный профиль: имя, имя пользователя, баллы, категории действий и число приглашённых (всего и активных). Личные заметки не показываются.';
 assert.equal(t('ru','referralPrivacyNotice'),ru);
 assert.equal(t('en','referralPrivacyNotice'),'The link recipient can also view your public profile: your name, username, LIFE points, action categories and invitation counts (total and active). Private notes are not shown.');
});
