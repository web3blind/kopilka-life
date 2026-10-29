const config = require('../config');
const { configured, CONSENT_VERSION } = require('./partnerService');
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
function base() { return new URL(config.appBaseUrl).origin; }
const copy = {
  ru: { brand:'Копилка жизни', about:'Маленькие действия заботы о себе', aboutTitle:'Копилка жизни — мягкий дневник заботы о себе',
    description:'Отмечай сон, движение, радость и благодарность. Копилка жизни помогает замечать заботу о себе без рейтингов, наказаний и обязательных заметок.',
    partnerTitle:'Партнёрство с Копилкой жизни', partnerDescription:'Обсудим партнёрство с Копилкой жизни. Расскажи о своём проекте и предложении: формат и стоимость согласуем лично, без автоматической оплаты.',
    intro:'Один клик — чтобы заметить то, что поддержало день. Сон, движение, радость, благодарность, дела и отдых складываются в личную картину заботы о себе.',
    how:'Как это работает', steps:['Отметь маленькое действие. Заметка необязательна.','Посмотри историю и картину своего дня.','При желании выбери мягкую недельную цель в договоре заботы.'],
    gentle:'Без гонки и наказаний', limits:'Пропуск не обнуляет ценность дня. «ЖИЗНЬ» — наглядный след действий, а не рейтинг человека. Сервис не даёт медицинских рекомендаций и не принимает платежи. Базовые возможности бесплатны.',
    offer:'Для проектов, которым близка бережная забота о себе', offerText:'Расскажи, что ты делаешь и какое сотрудничество предлагаешь. Обсудим уместный формат и условия индивидуально. Стоимость — по согласованию. Отправка заявки не означает принятия предложения и не запускает оплату.',
    name:'Имя или название проекта', email:'E-mail для ответа', message:'Предложение и ссылка на проект', consent:'Согласен на обработку имени, e-mail и текста заявки для обсуждения партнёрства и получения ответа по e-mail.',
    privacy:'Обработка данных заявки', data:'Заявка сохраняется на сервере и передаётся владельцу сервиса в личный Telegram-чат. Ответ владельца отправляется на указанный e-mail через Resend от имени сервиса. Для защиты формы используется Cloudflare Turnstile. Данные заявки и переписка удаляются из рабочей базы через 90 дней при работе обработчика; резервные копии могут сохраняться отдельно по политике сервиса. Не отправляй медицинские сведения, пароли и другие чувствительные данные. Для обращения о данных используй контакт из политики конфиденциальности.',
    submit:'Отправить заявку', unavailable:'Форма временно недоступна. Попробуй позже: защита и доставка должны быть настроены до приёма заявок.', open:'Открыть приложение', partners:'Партнёрам', aboutLink:'О сервисе', policy:'Конфиденциальность', terms:'Условия', status:'',
  },
  en: { brand:'Life Harbor', about:'Small acts of care, one day at a time', aboutTitle:'Life Harbor — a gentle self-care journal',
    description:'Notice sleep, movement, joy and gratitude. Life Harbor makes small acts of self-care visible without rankings, penalties or mandatory notes.',
    partnerTitle:'Partner with Life Harbor', partnerDescription:'Discuss a partnership with Life Harbor. Tell us about your project and proposal. Format and pricing are agreed individually, with no automatic payments.',
    intro:'One tap to notice what supported your day. Sleep, movement, joy, gratitude, everyday tasks and rest become a personal picture of self-care.',
    how:'How it works', steps:['Mark one small action. Notes are optional.','Explore your history and the picture of your day.','If you like, choose a gentle weekly goal in a care contract.'],
    gentle:'No race, no penalties', limits:'Missing a day does not reduce its value. LIFE is a visible trace of your actions, not a ranking of a person. The service does not provide medical advice or process payments. Core features are free.',
    offer:'For projects that share a gentle approach to self-care', offerText:'Tell us what you do and how you would like to collaborate. We will discuss a suitable format and terms individually. Pricing is by agreement. Sending an inquiry does not guarantee acceptance or initiate payment.',
    name:'Name or project name', email:'E-mail for our reply', message:'Proposal and project link', consent:'I consent to the processing of my name, e-mail and inquiry to discuss a partnership and receive an e-mail reply.',
    privacy:'Inquiry data', data:'Your inquiry is stored on the server and sent to the service owner in a private Telegram chat. The owner’s reply is sent to your e-mail through Resend on behalf of the service. Cloudflare Turnstile protects this form. Inquiry data and correspondence are removed from the working database after 90 days while the worker is running; backups may be retained separately under the service privacy policy. Do not send medical information, passwords or other sensitive data. For data requests, use the contact in the privacy policy.',
    submit:'Send inquiry', unavailable:'The form is temporarily unavailable. Please try later: protection and delivery must be configured before inquiries can be accepted.', open:'Open the app', partners:'Partnerships', aboutLink:'About', policy:'Privacy', terms:'Terms', status:'',
  }
};
function metadata({locale='ru',path='/about',title,description,type='WebPage'}) {
  const url = base()+path;
  const other = path.startsWith('/en/') ? path.slice(3) : '/en'+path;
  const schema = { '@context':'https://schema.org', '@type':type, name:title, description, url, inLanguage:locale,
    ...(type === 'SoftwareApplication' ? { applicationCategory:'LifestyleApplication', operatingSystem:'Web', isAccessibleForFree:true } : {}) };
  return `<title>${escape(title)}</title><meta name="description" content="${escape(description)}"><link rel="canonical" href="${escape(url)}">
<link rel="alternate" hreflang="${locale}" href="${escape(url)}"><link rel="alternate" hreflang="${locale==='ru'?'en':'ru'}" href="${escape(base()+other)}"><link rel="alternate" hreflang="x-default" href="${escape(base()+path.replace(/^\/en\//,'/'))}">
<meta property="og:type" content="website"><meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}"><meta property="og:url" content="${escape(url)}"><meta property="og:locale" content="${locale==='ru'?'ru_RU':'en_US'}"><meta name="twitter:card" content="summary">
<script type="application/ld+json">${JSON.stringify(schema).replace(/</g,'\\u003c')}</script>`;
}
function publicPage(locale, kind) {
  const c=copy[locale], prefix=locale==='en'?'/en':'', path=prefix+'/'+kind;
  const partner=kind==='partners', ready=configured();
  const title=partner?c.partnerTitle:c.aboutTitle, description=partner?c.partnerDescription:c.description;
  const form = `<h2>${escape(c.partnerTitle)}</h2><p>${escape(c.offerText)}</p>
<form id="partnerForm" novalidate data-locale="${locale}" data-site-key="${escape(ready?config.turnstileSiteKey:'')}" data-consent-version="${CONSENT_VERSION}">
<label for="partnerName">${escape(c.name)}</label><input id="partnerName" name="name" required maxlength="100" autocomplete="organization">
<label for="partnerEmail">${escape(c.email)}</label><input id="partnerEmail" name="email" type="email" required maxlength="254" autocomplete="email">
<label for="partnerMessage">${escape(c.message)}</label><textarea id="partnerMessage" name="message" required maxlength="2000" rows="7"></textarea>
<div class="honeypot" aria-hidden="true" inert><label for="website">Website</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
<label class="consent"><input name="consent" type="checkbox" required> ${escape(c.consent)} <a href="#inquiryPrivacy">${escape(c.privacy)}</a></label>
<div id="partnerCaptcha"></div><p id="partnerStatus" role="status" aria-live="polite">${ready?'':escape(c.unavailable)}</p>
<button type="submit" ${ready?'':'disabled'}>${escape(c.submit)}</button><noscript>${locale==='ru'?'Для отправки формы требуется JavaScript.':'JavaScript is required to send the form.'}</noscript></form>
<section id="inquiryPrivacy"><h2>${escape(c.privacy)}</h2><p>${escape(c.data)}</p></section>`;
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${metadata({locale,path,title,description,type:partner?'ContactPage':'SoftwareApplication'})}<link rel="stylesheet" href="/partner.css">${partner?'<script src="/partner.js" defer></script>':''}</head><body><a class="skip" href="#main">${locale==='ru'?'К содержанию':'Skip to content'}</a><header><a href="${prefix}/about">${escape(c.brand)}</a><nav aria-label="${locale==='ru'?'Навигация':'Navigation'}"><a href="${locale==='en'?'/?lang=en':'/'}">${escape(c.open)}</a> <a href="${prefix}/about">${escape(c.aboutLink)}</a> <a href="${prefix}/partners">${escape(c.partners)}</a> <a href="${prefix}/gratitude-journal">${locale==='ru'?'Дневник благодарности':'Gratitude journal'}</a> <a lang="${locale==='ru'?'en':'ru'}" href="${locale==='ru'?'/en':''}/${kind}">${locale==='ru'?'English':'Русский'}</a></nav></header><main id="main"><h1>${escape(partner?c.partnerTitle:c.about)}</h1><p>${escape(partner?c.offer:c.intro)}</p>${partner?form:`<h2>${escape(c.how)}</h2><ol>${c.steps.map(s=>`<li>${escape(s)}</li>`).join('')}</ol><h2>${escape(c.gentle)}</h2><p>${escape(c.limits)}</p><p><a href="${locale==='en'?'/?lang=en':'/'}">${escape(c.open)}</a> · <a href="${prefix}/partners">${escape(c.partners)}</a></p>`}</main><footer><a href="/privacy${locale==='en'?'.en':''}.html">${escape(c.policy)}</a> · <a href="/terms${locale==='en'?'.en':''}.html">${escape(c.terms)}</a></footer></body></html>`;
}
function installPublicPages(app) {
  for (const locale of ['ru','en']) {
    const path=(locale==='en'?'/en':'')+'/gratitude-journal';
    app.get(path,(req,res)=>res.set('Cache-Control','no-store').type('html').send(require('./gratitudePageService').gratitudePage(locale)));
  }
  for (const locale of ['ru','en']) for (const kind of ['about','partners']) {
    const path=(locale==='en'?'/en':'')+'/'+kind;
    app.get(path,(req,res)=>res.set('Cache-Control','no-store').type('html').send(publicPage(locale,kind)));
  }
  app.get('/robots.txt',(req,res)=>res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /telegram/\nDisallow: /p/\nSitemap: ${base()}/sitemap.xml\n`));
  app.get('/sitemap.xml',(req,res)=>res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/','/about','/en/about','/partners','/en/partners','/gratitude-journal','/en/gratitude-journal'].map(p=>`<url><loc>${escape(base()+p)}</loc></url>`).join('')}</urlset>`));
}
module.exports={ metadata, publicPage, installPublicPages, escape };
