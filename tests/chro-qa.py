#!/usr/bin/env python3
import asyncio, json, urllib.request, websockets
DEV='http://127.0.0.1:9222'
def tabs(): return json.loads(urllib.request.urlopen(DEV+'/json/list', timeout=10).read().decode())
def local_tab():
  matches=[t for t in tabs() if t.get('type')=='page' and '127.0.0.1:3107' in t.get('url','')]
  if matches:
    return matches[-1]
  raise RuntimeError('local tab not found')
async def eval_js(expr):
  tab=local_tab()
  async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=10_000_000) as ws:
    await ws.send(json.dumps({'id':1,'method':'Runtime.enable'}))
    await ws.send(json.dumps({'id':2,'method':'Runtime.evaluate','params':{'expression':expr,'awaitPromise':True,'returnByValue':True}}))
    while True:
      msg=json.loads(await ws.recv())
      if msg.get('id')==2:
        result=msg.get('result',{})
        if 'exceptionDetails' in msg or 'exceptionDetails' in result:
          raise RuntimeError(json.dumps(msg, ensure_ascii=False))
        return result.get('result',{}).get('value')
SCRIPT=r'''
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const text = (id) => document.getElementById(id).textContent.trim();
  for (let i = 0; i < 80; i++) {
    if (document.querySelectorAll('[data-tab]').length === 4 && document.getElementById('statusRegion')) break;
    await sleep(100);
  }
  for (let i = 0; i < 80 && !text('statusRegion').includes('Готово'); i++) await sleep(100);
  const out = [];
  out.push(['auth', text('connectionStatus')]);
  out.push(['a11y-static', Boolean(document.querySelector('.skip-link[href="#main"]')), Boolean(document.querySelector('main#main')), document.getElementById('statusRegion').getAttribute('role')]);
  document.querySelector('.skip-link').focus();
  out.push(['keyboard-focus', document.activeElement.classList.contains('skip-link')]);
  for (const tab of ['week','contract','settings','today']) {
    document.querySelector(`[data-tab="${tab}"]`).click();
    await sleep(120);
    out.push(['tab', tab, document.getElementById(`tab-${tab}`).hidden === false, document.querySelector(`[data-tab="${tab}"]`).getAttribute('aria-selected')]);
  }
  document.querySelector('[data-entry-type="sleep"]').click();
  await sleep(400);
  document.querySelector('[data-entry-type="gratitude"]').click();
  await sleep(400);
  out.push(['balance', text('totalLife'), text('todayLife'), text('statusRegion')]);
  document.querySelector('[data-tab="contract"]').click(); await sleep(120);
  document.getElementById('contractTitle').value = 'QA договор сна';
  document.getElementById('contractTarget').value = '5 дней из 7';
  document.getElementById('stakeAmount').value = '500';
  document.getElementById('stakeCurrency').value = 'RUB';
  document.getElementById('rewardDescription').value = 'чай';
  document.getElementById('fundDescription').value = 'фонд';
  document.getElementById('contractForm').requestSubmit();
  await sleep(500);
  out.push(['contract-created', document.getElementById('contractCurrent').textContent.includes('QA договор сна')]);
  document.querySelector('[data-close-status="completed"]').click();
  await sleep(500);
  out.push(['contract-closed', text('statusRegion'), text('totalLife')]);
  document.querySelector('[data-tab="settings"]').click(); await sleep(120);
  document.getElementById('remindersEnabled').checked = true;
  document.getElementById('eveningReminderTime').value = '21:15';
  document.getElementById('settingsForm').requestSubmit();
  await sleep(500);
  out.push(['settings', text('statusRegion')]);
  document.getElementById('cleanupDemo').click();
  await sleep(1000);
  out.push(['cleanup', text('statusRegion'), text('totalLife'), text('todayLife')]);
  document.querySelector('[data-tab="settings"]').click(); await sleep(120);
  document.getElementById('timezone').value = 'Invalid/Zone';
  document.getElementById('eveningReminderTime').value = '20:00';
  document.getElementById('settingsForm').requestSubmit();
  await sleep(500);
  out.push(['settings-normalized', document.getElementById('timezone').value, document.getElementById('eveningReminderTime').value]);
  out.push(['focusables', Array.from(document.querySelectorAll('button,input,textarea,a[href]')).filter((el)=>!el.closest('[hidden]')&&!el.disabled).length]);
  return JSON.stringify(out);
})()
'''
async def main():
  value=await eval_js(SCRIPT)
  data=json.loads(value)
  print(value)
  assert any(x[0]=='auth' and ('demo' in x[1].lower() or 'Подключено' in x[1]) for x in data)
  assert any(x[0]=='a11y-static' and x[1] and x[2] and x[3]=='status' for x in data)
  assert any(x[0]=='keyboard-focus' and x[1] for x in data)
  assert all(x[2] and x[3]=='true' for x in data if x[0]=='tab')
  assert any(x[0]=='balance' and x[1]=='4' and x[2]=='4' for x in data)
  assert any(x[0]=='contract-created' and x[1] for x in data)
  assert any(x[0]=='contract-closed' and int(x[2])>=14 for x in data)
  assert any(x[0]=='settings' and 'сохранены' in x[1] for x in data)
  assert any(x[0]=='cleanup' and x[2]=='0' and x[3]=='0' for x in data)
  assert any(x[0]=='settings-normalized' and x[1]=='UTC' and x[2]=='20:00' for x in data)
  print('chro qa passed')
asyncio.run(main())
