// One fixed storybook world: each quick entry reveals a localized painted detail.
// The semantic entry list and buttons remain the sources of accessible information.
(function (global) {
  const ASSETS = '/assets/day-scene/';
  // Source-image crop bounds in percent. The same bounds drive DOM and export.
  const POSITIONS = Object.freeze({
    sleep: [12, 70, 31, 82], dreamed: [12, 8, 33, 20], gratitude: [12, 38, 22, 49],
    dream_step: [77, 12, 93, 27], joy: [1, 3, 12, 11.25], family_time: [55, 45, 69, 56],
    food_water: [69, 67, 79, 78], rest: [76, 66, 97, 85], savoring: [14.5, 27, 26, 39],
    social_contact: [19, 19, 32, 29], gifted_joy: [24.5, 74, 38.5, 86],
    important_task: [61, 70, 71, 78], movement: [20, 82, 56, 98.5],
    honest_step: [46, 60, 65, 76], kind_trace: [83, 37, 95, 46],
    hard_day: [1.5, 70, 15.5, 91]
  });
  const loaded = new Map();
  const selected = new Set();
  function asset(name) { return `${ASSETS}${name === 'tree' ? 'tree' : `scene-${name}`}.webp?v=${name === 'movement' ? '5' : name === 'joy' ? '4' : '3'}`; }
  function trackSceneImage(image) {
    if (!image) return;
    if (!image.dataset.sceneTracked) {
      image.dataset.sceneTracked = 'true';
      image.dataset.sceneLoaded = 'false';
      image.addEventListener('load', () => {
        image.dataset.sceneLoaded = image.naturalWidth > 0 ? 'true' : 'false';
      });
      image.addEventListener('error', () => {
        image.dataset.sceneLoaded = 'false';
        image.dataset.sceneFailed = 'true';
      });
    }
    if (image.complete && image.naturalWidth > 0) {
      image.dataset.sceneLoaded = 'true';
      delete image.dataset.sceneFailed;
    } else if (image.dataset.sceneFailed === 'true' || (image.complete && image.getAttribute('src'))) {
      // Retry once on a subsequent render, never in an error-event loop.
      delete image.dataset.sceneFailed;
      image.dataset.sceneLoaded = 'false';
      image.src = image.getAttribute('src');
    }
  }
  function render(types, locale) {
    const layer = document.getElementById('daySceneLayer');
    const description = document.getElementById('daySceneDescription');
    if (!layer || !description) return;
    trackSceneImage(layer.parentElement?.querySelector(':scope > img'));
    const next = new Set((types || []).filter((type) => Object.hasOwn(POSITIONS, type)));
    selected.clear();
    for (const type of next) selected.add(type);
    for (const [type, [x1, y1, x2, y2]] of Object.entries(POSITIONS)) {
      let detail = layer.querySelector(`[data-scene-type="${type}"]`);
      if (!selected.has(type)) { if (detail) detail.hidden = true; continue; }
      if (!detail) {
        detail = document.createElement('span');
        detail.className = 'day-scene-motif';
        detail.dataset.sceneType = type;
        detail.style.left = `${x1}%`;
        detail.style.top = `${y1}%`;
        detail.style.width = `${x2 - x1}%`;
        detail.style.height = `${y2 - y1}%`;
        const image = document.createElement('img');
        image.src = asset(type);
        image.alt = '';
        image.decoding = 'async';
        detail.append(image);
        layer.append(detail);
      }
      trackSceneImage(detail.querySelector('img'));
      detail.hidden = false;
    }
    const labels = [...selected].map((type) => type === 'gratitude'
      ? global.KopilkaI18n.t(locale, 'gratitudePracticeHeading')
      : global.KopilkaI18n.entryType(locale, type)?.title).filter(Boolean);
    const text = labels.length ? global.KopilkaI18n.t(locale, 'daySceneWith', { items: labels.join(', ') }) : global.KopilkaI18n.t(locale, 'daySceneEmpty');
    if (description.textContent !== text) description.textContent = text;
  }
  function image(name) {
    if (!loaded.has(name)) loaded.set(name, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { loaded.delete(name); reject(new Error('Scene image unavailable')); };
      img.src = asset(name);
    }));
    return loaded.get(name);
  }
  async function share(locale, date, platform) {
    const current = [...selected];
    const canvas = document.createElement('canvas');
    canvas.width = 960; canvas.height = 1388;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = '#fff8ef';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#392518';
    context.font = 'bold 36px system-ui, sans-serif';
    context.fillText(global.KopilkaI18n.t(locale, 'daySceneTitle'), 30, 50);
    context.font = '24px system-ui, sans-serif';
    context.fillText(date, 32, 83);
    context.drawImage(await image('tree'), 0, 108, 960, 1280);
    for (const [type, [x1, y1, x2, y2]] of Object.entries(POSITIONS)) {
      if (!current.includes(type)) continue;
      context.drawImage(await image(type), x1 / 100 * 960, 108 + y1 / 100 * 1280,
        (x2 - x1) / 100 * 960, (y2 - y1) / 100 * 1280);
    }
    if (platform === 'vk' || platform === 'telegram') {
      if (platform === 'vk' && !global.vkBridge?.send) throw new Error('VK Bridge unavailable');
      const story = document.createElement('canvas');
      story.width = 1080; story.height = 1920;
      const storyContext = story.getContext('2d');
      if (!storyContext) throw new Error('Story canvas unavailable');
      storyContext.fillStyle = '#fff8ef';
      storyContext.fillRect(0, 0, story.width, story.height);
      storyContext.drawImage(canvas, 60, 260);
      if (platform === 'vk') {
        // Opaque backing for white native edge UI; phone positions vary.
        // Hard transitions at y=240/1760 stay outside the title and scene.
        // No fade: every backing pixel must retain normal-text contrast.
        storyContext.fillStyle = '#25362f';
        storyContext.fillRect(0, 0, story.width, 240);
        storyContext.fillRect(0, 1760, story.width, 160);
      }
      if (platform === 'telegram') {
        const png = await new Promise((resolve) => story.toBlob(resolve, 'image/png'));
        if (!png) throw new Error('Story PNG unavailable');
        return png;
      }
      let response;
      try {
        response = await global.vkBridge.send('VKWebAppShowStoryBox', {
          background_type: 'image',
          blob: story.toDataURL('image/png'),
          locked: true,
          attachment: { type: 'url', text: 'open', url: 'https://vk.com/app54723764' }
        });
      } catch (error) {
        if (error?.error_data?.error_reason === 'User denied') return 'cancelled';
        throw error;
      }
      if (response?.result !== true && !response?.code_data) throw new Error('VK story editor unavailable');
      return 'story_editor';
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('Canvas export failed');
    const file = new File([blob], 'kartina-dnya.png', { type: 'image/png' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: global.KopilkaI18n.t(locale, 'daySceneTitle') }); return 'shared'; }
      catch (error) { if (error?.name === 'AbortError') return 'cancelled'; throw error; }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = file.name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return 'downloaded';
  }
  global.KopilkaDayScene = { render, share, positions: POSITIONS };
})(window);
