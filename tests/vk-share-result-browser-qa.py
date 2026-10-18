#!/usr/bin/env python3
"""Connected RU/EN share UI with pinned SDK callback fixtures; no provider traffic."""
import tempfile
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import time
import urllib.parse
from playwright.sync_api import sync_playwright

BASE = os.environ['KOPILKA_QA_BASE_URL']
assert BASE == 'http://127.0.0.1:3312'
assert os.environ['NODE_ENV'] == 'test' and 'qa.sqlite' in os.environ['DB_PATH']
assert 'review-b-provider-block.cjs' in os.environ.get('NODE_OPTIONS', '')
ARTIFACT = Path(os.environ.get('KOPILKA_SHARE_ARTIFACT', (tempfile.gettempdir() + '/kopilka-qa/kopilka-all-remaining-20261008/share-result-7615520.json')))
params = {'vk_app_id': '54723764', 'vk_user_id': '81997615', 'vk_ts': str(int(time.time())), 'vk_platform': 'desktop_web'}
params['sign'] = base64.urlsafe_b64encode(hmac.new(b'browser-qa-vk-secure-key', urllib.parse.urlencode(sorted(params.items())).encode(), hashlib.sha256).digest()).decode().rstrip('=')
BRIDGE = r"""
window.qaBridgeCalls=[];window.qaShareResult={};window.qaShareError=null;window.qaCopyResult=true;
// Native transport fixture only. The shipped SDK handles request IDs and array spreading.
window.AndroidBridge=new Proxy({}, {get(target,method){return raw=>{
 const p=JSON.parse(raw);qaBridgeCalls.push({method,params:p});
 let data={result:true};let type=method+'Result';
 if(method==='VKWebAppGetUserInfo')data={id:81997615,first_name:'Fixture',last_name:'Only'};
 if(method==='VKWebAppGetLaunchParams')data=Object.fromEntries(new URLSearchParams(location.search));
 if(method==='VKWebAppShare') {data=qaShareError||qaShareResult;if(qaShareError)type=method+'Failed';}
 if(method==='VKWebAppCopyText')data={result:qaCopyResult};
 data=Array.isArray(data)?Object.assign([...data],{request_id:p.request_id}):{...data,request_id:p.request_id};
 setTimeout(()=>window.dispatchEvent(new CustomEvent('VKWebAppEvent',{detail:{type,data}})),0);
}}});
window.qaOtherShareCalls=[];
Object.defineProperty(navigator,'share',{configurable:true,value:undefined});
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>qaOtherShareCalls.push('clipboard')}});
"""
CASES = [
    ('sdk-message-array', [{'type':'message','users':[{'id':1}]}], 'shareCompleted'),
    ('sdk-message-single', {'type':'message','users':[{'id':1}]}, 'shareCompleted'),
    ('sdk-message-numeric', {'0':{'type':'message','users':[{'id':1}]}}, 'shareCompleted'),
    ('sdk-story-single', {'type':'story','story_id':'fixture-story'}, 'sharePublicationCompleted'),
    ('sdk-post-array', [{'type':'post','post_id':'fixture-post'}], 'sharePublicationCompleted'),
    ('sdk-story-numeric', {'0':{'type':'story','story_id':'fixture-story'}}, 'sharePublicationCompleted'),
    ('sdk-legacy', {'result':True}, 'shareActionCompleted'),
    ('sdk-qr', [{'type':'qr'}], 'shareUnconfirmed'),
    ('sdk-link', {'type':'link'}, 'shareUnconfirmed'),
    ('sdk-other', {'0':{'type':'other'}}, 'shareUnconfirmed'),
    ('sdk-empty-array', [], 'shareUnconfirmed'),
    ('sdk-empty-object', {}, 'shareUnconfirmed'),
    ('sdk-empty-recipients', [{'type':'message','users':[]}], 'shareUnconfirmed'),
    ('sdk-missing-story-id', {'type':'story'}, 'shareUnconfirmed'),
    ('sdk-unknown', {'type':'unexpected','result':True}, 'shareUnconfirmed'),
    ('direct-message-array', [{'type':'message','users':[{'id':1}]}], 'shareCompleted'),
]
report = {'bug':'7615520','base':BASE,'fixture':'review-b-provider-block.cjs','cases':[],'browser_outbound_attempts':[],'pageerrors':[]}
with sync_playwright() as pw:
    browser = pw.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    ctx = browser.new_context(viewport={'width':390,'height':800})
    try:
        def route(r):
            if r.request.url.startswith(BASE+'/'):
                r.continue_()
            else:
                report['browser_outbound_attempts'].append(r.request.url)
                r.fulfill(status=200, body='', content_type='application/javascript')
        ctx.route('**/*', route)
        ctx.add_init_script(BRIDGE)
        page = ctx.new_page()
        page.on('pageerror', lambda e:report['pageerrors'].append(str(e)))
        page.goto(BASE+'/?'+urllib.parse.urlencode(params))
        page.wait_for_function('state.user && state.profile && !state.busy', timeout=25000)
        page.locator('#tab-button-profile').click()
        page.evaluate("""()=>{window.qaRealSend=vkBridge.send.bind(vkBridge);vkBridge.send=async(m,p)=>{
         if(m==='VKWebAppShare' && qaDirect){qaBridgeCalls.push({method:m,params:p});qaObservedResult=qaShareResult;return qaShareResult;}
         const r=await qaRealSend(m,p);if(m==='VKWebAppShare')qaObservedResult=r;return r;
        };window.qaDirect=false;}""")
        for locale in ['ru','en']:
            page.evaluate('(l)=>{state.user.locale=l;renderAll()}', locale)
            for name, result, key in CASES:
                page.evaluate("(v)=>{qaDirect=v.direct;qaShareResult=v.result;qaShareError=null;qaBridgeCalls=[];qaOtherShareCalls=[];setStatus('pending')}", {'direct':name.startswith('direct'),'result':result})
                page.locator('#shareRefLink').click()
                expected = page.evaluate('(k)=>L(k)', key)
                page.wait_for_function('(t)=>document.querySelector("#statusRegion").textContent===t', arg=expected)
                calls = page.evaluate('qaBridgeCalls.map(c=>c.method)')
                assert calls == ['VKWebAppShare'], (name,calls)
                assert page.evaluate('qaOtherShareCalls') == []
                observed = page.evaluate('qaObservedResult')
                if name=='sdk-message-array':
                    assert isinstance(observed,dict) and '0' in observed and 'request_id' not in observed, observed
                assert page.locator('#shareFallback').is_visible() == (key=='shareUnconfirmed')
                if key=='shareUnconfirmed':
                    assert page.locator('#shareFallbackLink').input_value()
                report['cases'].append({'locale':locale,'case':name,'status':expected,'sdk_result':observed,'calls':calls})
            # All fallback methods are present and instrumented during explicit cancellation.
            page.evaluate("""()=>{qaDirect=false;qaShareError={error_type:'client_error',error_data:{error_code:4}};qaBridgeCalls=[];qaOtherShareCalls=[];setStatus('pending');
             Object.defineProperty(navigator,'share',{configurable:true,value:async()=>qaOtherShareCalls.push('native-share')});
             window.Telegram={WebApp:{initData:'fixture-only',switchInlineQuery:()=>qaOtherShareCalls.push('telegram-inline'),openTelegramLink:()=>qaOtherShareCalls.push('telegram-link')}};
            }""")
            page.locator('#shareRefLink').click()
            expected = page.evaluate('L("shareCancelled")')
            page.wait_for_function('(t)=>document.querySelector("#statusRegion").textContent===t', arg=expected)
            assert page.evaluate('qaBridgeCalls.map(c=>c.method)') == ['VKWebAppShare']
            assert page.evaluate('qaOtherShareCalls') == []
            assert not page.locator('#shareFallback').is_visible()
            report['cases'].append({'locale':locale,'case':'explicit-cancel','status':expected,'calls':['VKWebAppShare'],'fallback_calls':[]})
            for copy_ok in [True,False]:
                page.evaluate("""(ok)=>{delete window.Telegram;Object.defineProperty(navigator,'share',{configurable:true,value:undefined});
                 qaShareError={error_type:'client_error',error_data:{error_code:5}};qaCopyResult=ok;qaBridgeCalls=[];qaOtherShareCalls=[];setStatus('pending');} """, copy_ok)
                page.locator('#shareProfile').click()
                expected = page.evaluate('(k)=>L(k)', 'copied' if copy_ok else 'copyFailed')
                page.wait_for_function('(t)=>document.querySelector("#statusRegion").textContent===t', arg=expected)
                assert page.evaluate('qaBridgeCalls.map(c=>c.method)') == ['VKWebAppShare','VKWebAppCopyText']
                assert page.evaluate('qaOtherShareCalls') == []
                assert page.locator('#shareFallback').is_visible() == (not copy_ok)
                report['cases'].append({'locale':locale,'case':'genuine-failure-copy-'+str(copy_ok),'status':expected,'calls':['VKWebAppShare','VKWebAppCopyText']})
        assert not report['pageerrors'], report['pageerrors']
        # Only the landing page's harmless third-party SDK script may be attempted; every request was fulfilled locally.
        assert all(u=='https://telegram.org/js/telegram-web-app.js' for u in report['browser_outbound_attempts']), report['browser_outbound_attempts']
        report['passed']=len(report['cases'])
        ARTIFACT.parent.mkdir(parents=True, exist_ok=True)
        ARTIFACT.write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print(f"SHARE_RESULT_PASS {report['passed']} connected cases RU/EN; outbound delivered=0; pageerrors=0; artifact={ARTIFACT}")
    finally:
        ctx.unroute_all(behavior='ignoreErrors')
        ctx.close()
        browser.close()
