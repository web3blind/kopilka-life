// A readable guide, rendered without client scripts or account access.
const content = {
  ru: {
    title: 'Дневник благодарности: как начать и что писать',
    description: 'Как вести дневник благодарности без обязательств: короткий пример записи, вопросы для начала и способ отмечать благодарность в Копилке жизни.',
    brand: 'Копилка жизни', about: 'О сервисе', open: 'Открыть Копилку жизни', skip: 'К содержанию', nav: 'Навигация',
    intro: 'Дневник благодарности — это место для конкретных вещей, которые хочется заметить и сохранить: чьей-то помощи, приятного момента или собственного усилия. Не нужно убеждать себя, что день был хорошим. Можно признать, что он был тяжёлым, и всё же отметить что-то поддерживающее.',
    start: 'Как вести дневник благодарности',
    steps: ['Выбери удобное место: бумажный блокнот, заметки в телефоне или приложение. Важнее удобство, чем красивое оформление.', 'Вспомни один конкретный момент. Не «благодарю за всё», а «друг выслушал меня, когда было тревожно».', 'Если хочется, добавь, почему это было важно. Одной фразы достаточно; три пункта и длинный текст не обязательны.', 'Возвращайся, когда есть желание. Можно попробовать вечером или после приятного события, но пропущенные дни не нужно заполнять задним числом.'],
    example: 'Пример короткой записи',
    sample: 'Сегодня благодарен коллеге: она помогла разобраться с задачей, и я смог закончить работу без спешки. Себе — за то, что попросил о помощи.',
    sampleNote: 'Это вымышленный пример, а не образец «правильной» благодарности. В твоей записи может быть один человек, одно ощущение или маленькая бытовая деталь.',
    prompts: 'Что писать, если ничего не приходит в голову',
    questions: ['Кто сегодня сделал мою жизнь чуть легче?', 'Какой маленький момент был приятным: тёплый чай, музыка, спокойная дорога?', 'За какое своё действие я могу себя поблагодарить?', 'Что помогло выдержать непростой день?'],
    hard: 'А если благодарить совсем не за что?',
    hardText: 'Не выжимай из себя позитив. Можно записать «сегодня тяжело, не хочу искать хорошее», выбрать отдых или ничего не отмечать. Благодарность не отменяет злость, грусть и реальные трудности. Эта практика — не лечение и не замена профессиональной помощи.',
    app: 'Как отмечать благодарность в Копилке',
    appText: 'В Копилке жизни на вкладке «Сегодня» можно отметить благодарность одним нажатием. Заметка необязательна: если хочется, добавь короткую фразу о том, что тебя поддержало. Позже к записи можно вернуться в «Истории». Это один из способов заботы о себе рядом со сном, движением, радостью и отдыхом, а не обязательный ежедневный отчёт.',
    privacy: 'Личные заметки не показываются в публичном профиле и карточке для публикации. Не добавляй в них пароли и чужие чувствительные сведения.',
    end: 'Можно начать с одной маленькой вещи. И на этом остановиться.', policy: 'Конфиденциальность', terms: 'Условия'
  },
  en: {
    title: 'Gratitude journal: how to start and what to write',
    description: 'Start a gratitude journal without pressure: a short sample entry, simple prompts and a way to notice gratitude in Life Harbor, with optional notes.',
    brand: 'Life Harbor', about: 'About', open: 'Open Life Harbor', skip: 'Skip to content', nav: 'Navigation',
    intro: 'A gratitude journal is a place to notice and keep specific things you appreciate: someone’s help, a pleasant moment or your own effort. You do not have to convince yourself that the day was good. It can have been difficult and still contain something that supported you.',
    start: 'How to keep a gratitude journal',
    steps: ['Choose somewhere convenient: a paper notebook, notes on your phone or an app. Ease matters more than a beautiful layout.', 'Recall one specific moment. Instead of “grateful for everything”, try “a friend listened when I felt anxious”.', 'If you like, add why it mattered. One sentence is enough; three items and a long entry are not required.', 'Come back when you want to. You could try the evening or a moment after something pleasant happens, but there is no need to fill in missed days.'],
    example: 'A short example entry',
    sample: 'Today I’m grateful to my colleague for helping me work through a task, so I could finish without rushing. And to myself for asking for help.',
    sampleNote: 'This is a fictional example, not a model of “correct” gratitude. Your entry might be about one person, a feeling or a small everyday detail.',
    prompts: 'What to write when nothing comes to mind',
    questions: ['Who made my life a little easier today?', 'What small moment felt pleasant: warm tea, music or a quiet journey?', 'What is one thing I did that I can thank myself for?', 'What helped me get through a difficult day?'],
    hard: 'What if I cannot find anything to be grateful for?',
    hardText: 'Do not force positivity. You can write “today is hard and I do not want to look for the good”, choose rest or leave it unmarked. Gratitude does not cancel out anger, sadness or real difficulties. This practice is not treatment or a substitute for professional help.',
    app: 'Noticing gratitude in Life Harbor',
    appText: 'In Life Harbor, you can mark gratitude with one tap on the Today tab. Notes are optional: add a short sentence about what supported you if you wish. You can revisit the entry in History. Gratitude is one form of self-care alongside sleep, movement, joy and rest, not a compulsory daily report.',
    privacy: 'Personal notes do not appear on your public profile or share card. Avoid adding passwords or sensitive information about other people.',
    end: 'You can start with one small thing. And stop there.', policy: 'Privacy', terms: 'Terms'
  }
};
function gratitudePage(locale) {
  const { metadata, escape } = require('./publicSeoService');
  const c = content[locale], prefix = locale === 'en' ? '/en' : '';
  const path = prefix + '/gratitude-journal', app = locale === 'en' ? '/?lang=en' : '/';
  const list = (items) => items.map(item => `<li>${escape(item)}</li>`).join('');
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${metadata({locale,path,title:c.title,description:c.description})}<link rel="stylesheet" href="/partner.css"></head><body><a class="skip" href="#main">${escape(c.skip)}</a><header><a href="${prefix}/about">${escape(c.brand)}</a><nav aria-label="${escape(c.nav)}"><a href="${prefix}/about">${escape(c.about)}</a><a href="${app}">${escape(c.open)}</a><a lang="${locale === 'ru' ? 'en' : 'ru'}" hreflang="${locale === 'ru' ? 'en' : 'ru'}" href="${locale === 'ru' ? '/en' : ''}/gratitude-journal">${locale === 'ru' ? 'English' : 'Русский'}</a></nav></header><main id="main"><article><h1>${escape(c.title)}</h1><p>${escape(c.intro)}</p><h2>${escape(c.start)}</h2><ol>${list(c.steps)}</ol><h2>${escape(c.example)}</h2><blockquote><p>${escape(c.sample)}</p></blockquote><p>${escape(c.sampleNote)}</p><h2>${escape(c.prompts)}</h2><ul>${list(c.questions)}</ul><h2>${escape(c.hard)}</h2><p>${escape(c.hardText)}</p><h2>${escape(c.app)}</h2><p>${escape(c.appText)}</p><p>${escape(c.privacy)}</p><p><a href="${app}">${escape(c.open)}</a></p><p>${escape(c.end)}</p></article></main><footer><a href="${prefix}/about">${escape(c.about)}</a> · <a href="/privacy${locale === 'en' ? '.en' : ''}.html">${escape(c.policy)}</a> · <a href="/terms${locale === 'en' ? '.en' : ''}.html">${escape(c.terms)}</a></footer></body></html>`;
}
module.exports = { gratitudePage };
