'use strict';
(() => {
  const form=document.querySelector('#partnerForm');
  if (!form) return;
  const en=form.dataset.locale==='en', status=document.querySelector('#partnerStatus'), button=form.querySelector('button');
  let token='', widget, busy=false, key=crypto.randomUUID(), saved=false;
  const tell=(ru,eng)=>{status.textContent=en?eng:ru;};
  const reset=()=>{token=''; if (window.turnstile && widget !== undefined) window.turnstile.reset(widget);};
  // Keep one idempotency identity through network retries; edits represent a new inquiry.
  form.addEventListener('input',()=>{if (!busy) {key=crypto.randomUUID(); saved=false;button.disabled=!form.dataset.siteKey;}});
  if (form.dataset.siteKey) {
    const script=document.createElement('script');
    script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload=()=>{ widget=window.turnstile.render('#partnerCaptcha',{
      sitekey:form.dataset.siteKey, action:'partner_inquiry', language:en?'en':'ru',
      callback:(value)=>{token=value;}, 'expired-callback':()=>{token='';},
      'error-callback':()=>{token='';tell('Защита не загрузилась. Проверь соединение и попробуй ещё раз.','Verification could not load. Check your connection and try again.');}
    }); };
    script.onerror=()=>tell('Защита не загрузилась. Попробуй позже.','Verification could not load. Please try later.');
    document.head.append(script);
  }
  form.addEventListener('submit',async(event)=>{
    event.preventDefault();
    if (busy || saved || !form.dataset.siteKey) return;
    if (!token) {tell('Пройди проверку защиты перед отправкой.','Complete verification before sending.');return;}
    if (!form.checkValidity()) {
      const invalid=form.querySelector(':invalid');
      const errors={name:['Укажи имя или название проекта (до 100 символов).','Enter your name or project name (up to 100 characters).'],email:['Укажи корректный e-mail для ответа.','Enter a valid e-mail address for our reply.'],message:['Опиши предложение (до 2000 символов).','Describe your proposal (up to 2000 characters).'],consent:['Подтверди согласие на обработку заявки.','Confirm your consent to inquiry processing.']};
      tell(...(errors[invalid?.name] || ['Проверь поля формы.','Check the form fields.']));
      invalid?.focus();return;
    }
    busy=true;button.disabled=true;form.setAttribute('aria-busy','true');
    tell('Сохраняем заявку…','Saving your inquiry…');
    const fields=new FormData(form);
    form.querySelectorAll('input,textarea').forEach(control=>{control.disabled=true;});
    try {
      const response=await fetch('/api/partners/inquiries',{
        method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),
        body:JSON.stringify({ name:fields.get('name'),email:fields.get('email'),message:fields.get('message'),
          website:fields.get('website'),consent:fields.get('consent')==='on',locale:form.dataset.locale,captchaToken:token,submissionKey:key })
      });
      const data=await response.json();
      if (!response.ok || data.saved !== true || typeof data.id !== 'string') {
        if (response.status===429) tell('Слишком много заявок. Попробуй позже. Текст сохранён в форме.','Too many inquiries. Try later. Your text is still in the form.');
        else if (data.code==='CAPTCHA_REJECTED') tell('Проверка защиты не пройдена. Пройди её ещё раз.','Verification failed. Please complete it again.');
        else tell('Не удалось сохранить заявку. Текст остался в форме. Попробуй позже.','The inquiry could not be saved. Your text is still in the form. Please try later.');
        reset();return;
      }
      saved=true;
      tell(`Заявка сохранена. Номер: ${data.id}. Ответ придёт на указанный e-mail после рассмотрения.`,`Inquiry saved. Reference: ${data.id}. A reply will be sent to your e-mail after review.`);
    } catch (_) {
      tell('Не удалось подтвердить сохранение. Повтори отправку без изменения полей: дубль не создастся.','Saving could not be confirmed. Retry without changing the fields: no duplicate will be created.');
      // Keep the token/key: a saved retry is idempotent even if its CAPTCHA expired.
    } finally {busy=false;button.disabled=saved;form.querySelectorAll('input,textarea').forEach(control=>{control.disabled=false;});form.removeAttribute('aria-busy');}
  });
})();
