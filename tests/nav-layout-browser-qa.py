#!/usr/bin/env python3
"""Real Chromium geometry; optional read-only historical six-tab comparison.

Run directly (no server needed). --baseline 5c7e405 also measures that revision's
actual HTML, CSS and translations, not today's labels in an old-looking grid.
Connected navigation/focus behavior is covered by ai-weekly-browser-qa.py.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
VIEWPORTS = [(320,568),(360,640),(390,844),(560,600),(768,1024),
             (1024,768),(1440,900),(390,320),(844,390)]
GEOMETRY = """() => {
 const nav=document.querySelector('.tab-bar'), n=nav.getBoundingClientRect();
 const buttons=[...nav.querySelectorAll('button')];
 const failures=[];
 const inside=(r,p)=>r.left>=p.left-.5&&r.right<=p.right+.5&&r.top>=p.top-.5&&r.bottom<=p.bottom+.5;
 const viewport={left:visualViewport?.offsetLeft||0,top:visualViewport?.offsetTop||0,
   right:(visualViewport?.offsetLeft||0)+(visualViewport?.width||innerWidth),
   bottom:(visualViewport?.offsetTop||0)+(visualViewport?.height||innerHeight)};
 if(!inside(n,viewport)) failures.push('nav outside viewport');
 if(nav.scrollWidth>nav.clientWidth+1||nav.scrollHeight>nav.clientHeight+1) failures.push('nav overflow');
 if(document.documentElement.scrollWidth>viewport.right-viewport.left+1) failures.push('document x overflow');
 const rects=buttons.map(b=>b.getBoundingClientRect());
 buttons.forEach((b,i)=>{
  const r=rects[i];
  if(r.width<44||r.height<44) failures.push(b.id+': target <44');
  if(!inside(r,n)||!inside(r,viewport)) failures.push(b.id+': outside');
  if(b.scrollWidth>b.clientWidth+1||b.scrollHeight>b.clientHeight+1) failures.push(b.id+': clipped');
  const walk=document.createTreeWalker(b,NodeFilter.SHOW_TEXT);
  while(walk.nextNode()) {
   const t=walk.currentNode;
   if(!t.textContent.trim()||!t.parentElement.getClientRects().length) continue;
   const range=document.createRange(); range.selectNodeContents(t);
   for(const tr of range.getClientRects()) if(!inside(tr,r)) failures.push(b.id+': label clipped');
  }
  for(let j=0;j<i;j++) {
   const p=rects[j];
   if(Math.min(r.right,p.right)-Math.max(r.left,p.left)>.5&&Math.min(r.bottom,p.bottom)-Math.max(r.top,p.top)>.5) failures.push('overlap');
  }
 });
 return {viewportWidth:innerWidth,viewportHeight:innerHeight,navHeight:n.height,spaceAboveNav:n.top,
  minimumTargetWidth:Math.min(...rects.map(r=>r.width)),count:buttons.length,failures};
}"""

def source(path, revision=None):
    return subprocess.check_output(['git','show',f'{revision}:{path}'],cwd=ROOT,text=True) if revision else (ROOT/path).read_text()

def document(revision=None):
    html=source('public/index.html',revision)
    nav=re.search(r'<nav class="tab-bar"[\s\S]*?</nav>',html).group()
    return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+source('public/styles.css',revision)+'</style><div id="appShell" class="app-shell">'+nav+'</div>'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline',help='optional historical git revision; never checked out')
    args=parser.parse_args()
    results=[]
    with sync_playwright() as pw:
        browser=pw.chromium.connect_over_cdp(os.environ.get('KOPILKA_QA_CDP_URL','http://127.0.0.1:18800'))
        context=browser.new_context(service_workers='block')
        try:
            page=context.new_page()
            page.route('**/*',lambda route:route.abort())
            for revision in ([args.baseline,None] if args.baseline else [None]):
                page.set_content(document(revision))
                page.add_script_tag(content=source('public/i18n.js',revision))
                for lang in ('ru','en'):
                    page.evaluate('''lang=>{
                      document.documentElement.lang=lang;
                      document.querySelectorAll('[data-i18n]').forEach(e=>e.textContent=KopilkaI18n.t(lang,e.dataset.i18n));
                      document.querySelectorAll('[data-i18n-aria]').forEach(e=>e.setAttribute('aria-label',KopilkaI18n.t(lang,e.dataset.i18nAria)));
                    }''',lang)
                    for scale in (100,200):
                        page.evaluate('scale=>document.documentElement.style.fontSize=scale+"%"',scale)
                        for width,height in VIEWPORTS:
                            page.set_viewport_size({'width':width,'height':height})
                            for badge in (False,True):
                                page.evaluate('''({lang,badge})=>{
                                  const c=document.getElementById('supportNewCount');
                                  c.hidden=!badge;
                                  c.textContent=KopilkaI18n.t(lang,'supportTabNewShort',{count:1});
                                  document.getElementById('tab-button-support').setAttribute('aria-label',
                                    KopilkaI18n.t(lang,badge?'supportTabNew':'tabSupport',{count:1}));
                                }''',{'lang':lang,'badge':badge})
                                row=page.evaluate(GEOMETRY)
                                row.update(revision=revision or 'working-tree',locale=lang,textPercent=scale,badge=badge)
                                results.append(row)
        finally:
            context.close()  # CDP is shared: never close its browser or other pages.
    current=[r for r in results if r['revision']=='working-tree']
    failures=[r for r in current if r['failures']]
    print(json.dumps({'measurements':results,'currentCases':len(current),'currentFailures':len(failures)},ensure_ascii=False))
    assert len(current)==72
    assert all(r['count']==7 for r in current)
    assert not failures, failures
    if args.baseline:
        baseline=[r for r in results if r['revision']==args.baseline]
        assert len(baseline)==72 and all(r['count']==6 for r in baseline)
        key=lambda r:(r['locale'],r['textPercent'],r['viewportWidth'],r['viewportHeight'],r['badge'])
        old={key(r):r for r in baseline}
        assert all(r['navHeight']<=old[key(r)]['navHeight']+1 for r in current), 'seven-tab dock takes more height than six-tab baseline'

if __name__=='__main__':
    main()
