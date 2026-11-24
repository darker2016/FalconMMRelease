// P9 网页内注入：悬停收藏 + 批量选择浮条。只在用户手势后按需注入。
(() => {
  if (window.__falconInjected) return
  window.__falconInjected = true

  const host = document.createElement('div')
  host.style.position = 'fixed'
  host.style.inset = '0'
  host.style.pointerEvents = 'none'
  host.style.zIndex = '2147483000'
  document.documentElement.appendChild(host)
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    .hint { position: absolute; display: none; width: 28px; height: 28px; border-radius: 6px;
      background: #1B2026; border: 1px solid #3A424C; color: #E8ECF0; align-items: center; justify-content: center;
      cursor: pointer; pointer-events: auto; box-shadow: 0 8px 24px #08090B; }
    .hint:hover { border-color: #C6A15B; }
    .hint svg { width: 14px; height: 14px; }
    .bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: none;
      align-items: center; gap: 8px; height: 40px; padding: 0 10px; border-radius: 10px;
      background: #1B2026; border: 1px solid #3A424C; color: #E8ECF0; font: 12px/1.4 system-ui, sans-serif;
      pointer-events: auto; box-shadow: 0 8px 24px #08090B; }
    .bar button { height: 28px; padding: 0 10px; border-radius: 4px; border: none; cursor: pointer;
      background: #20262E; color: #E8ECF0; font: inherit; }
    .bar button.primary { background: #C6A15B; color: #17120A; }
    .bar button:disabled { opacity: .45; cursor: not-allowed; }
    .check { position: absolute; width: 18px; height: 18px; border-radius: 4px; border: 1px solid #3A424C;
      background: #07090B; pointer-events: auto; cursor: pointer; display: none; }
    .check.on { background: #C6A15B; border-color: #C6A15B; }
    .check.on::after { content: ''; position: absolute; left: 5px; top: 1px; width: 4px; height: 9px;
      border-right: 2px solid #17120A; border-bottom: 2px solid #17120A; transform: rotate(45deg); }
  `
  shadow.appendChild(style)

  const hint = document.createElement('button')
  hint.className = 'hint'
  hint.title = '保存到素材库 Inbox'
  hint.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
  shadow.appendChild(hint)

  const bar = document.createElement('div')
  bar.className = 'bar'
  bar.innerHTML =
    '<span data-count>已选 0 项</span><button data-all>全选</button><button data-clear>清空</button><button class="primary" data-go disabled>抓取</button><button data-close>关闭</button>'
  shadow.appendChild(bar)

  let selecting = false
  let current = null
  const selected = new Map()
  const checks = new Map()

  const mediaItems = () => {
    const out = []
    const seen = new Set()
    const add = (el, url, kind) => {
      if (!url || seen.has(url)) return
      seen.add(url)
      const rect = el.getBoundingClientRect()
      if (rect.width < 40 || rect.height < 40) return
      const abs = /^https?:/i.test(url) ? url : url
      const bad = url.startsWith('blob:') || /\.m3u8|\.mpd/i.test(url)
      out.push({
        el,
        item: {
          url: abs,
          kind,
          width: el.naturalWidth || el.videoWidth || Math.round(rect.width),
          height: el.naturalHeight || el.videoHeight || Math.round(rect.height),
          durationMs: kind === 'video' ? Math.round((el.duration || 0) * 1000) : undefined,
          capturable: !bad,
          reason: bad ? (url.startsWith('blob:') ? 'mse_blob' : 'hls_manifest') : undefined,
          pageTitle: document.title
        }
      })
    }
    for (const img of document.images) add(img, img.currentSrc || img.src, 'image')
    for (const v of document.querySelectorAll('video')) add(v, v.currentSrc || v.src, 'video')
    return out
  }

  const positionHint = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
      hint.style.display = 'none'
      return
    }
    hint.style.left = `${Math.min(innerWidth - 36, Math.max(4, rect.right - 32))}px`
    hint.style.top = `${Math.min(innerHeight - 36, Math.max(4, rect.top + 6))}px`
    hint.style.display = 'flex'
    current = el
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      if (selecting) return
      const el = e.target.closest?.('img,video')
      if (el) positionHint(el)
    },
    true
  )
  document.addEventListener(
    'mouseout',
    (e) => {
      if (e.target.closest?.('img,video') && !e.relatedTarget?.closest?.('img,video')) hint.style.display = 'none'
    },
    true
  )

  hint.addEventListener('click', async (e) => {
    e.stopPropagation()
    e.preventDefault()
    if (!current) return
    const entry = mediaItems().find((m) => m.el === current)
    hint.style.display = 'none'
    if (!entry) return
    hint.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9" stroke-dasharray="4 3"/></svg>'
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'capture_one',
        item: entry.item,
        pageUrl: location.href,
        pageTitle: document.title
      })
      const ok = res?.ok && (res.added > 0 || res.duplicates > 0)
      hint.innerHTML = ok
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="#6FAE86" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="#C96A6A" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>'
    } catch {
      hint.innerHTML = ''
    }
    setTimeout(() => {
      hint.style.display = 'none'
      hint.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
    }, 1200)
  })

  const updateBar = () => {
    bar.querySelector('[data-count]').textContent = `已选 ${selected.size} 项`
    bar.querySelector('[data-go]').disabled = selected.size === 0
    bar.querySelector('[data-go]').textContent = `抓取 ${selected.size} 项`
  }

  const enterSelect = () => {
    selecting = true
    hint.style.display = 'none'
    bar.style.display = 'flex'
    for (const { el, item } of mediaItems()) {
      const rect = el.getBoundingClientRect()
      const box = document.createElement('div')
      box.className = 'check'
      box.style.display = 'block'
      box.style.left = `${Math.min(innerWidth - 22, Math.max(4, rect.right - 22))}px`
      box.style.top = `${Math.min(innerHeight - 22, Math.max(4, rect.top + 4))}px`
      box.addEventListener('click', (e) => {
        e.stopPropagation()
        e.preventDefault()
        if (selected.has(item.url)) {
          selected.delete(item.url)
          box.classList.remove('on')
        } else if (item.capturable !== false) {
          selected.set(item.url, item)
          box.classList.add('on')
        }
        updateBar()
      })
      shadow.appendChild(box)
      checks.set(item.url, box)
    }
    updateBar()
  }

  const exitSelect = () => {
    selecting = false
    bar.style.display = 'none'
    for (const box of checks.values()) box.remove()
    checks.clear()
    selected.clear()
  }

  bar.querySelector('[data-all]').addEventListener('click', () => {
    for (const { item } of mediaItems()) {
      if (item.capturable === false) continue
      selected.set(item.url, item)
      checks.get(item.url)?.classList.add('on')
    }
    updateBar()
  })
  bar.querySelector('[data-clear]').addEventListener('click', () => {
    selected.clear()
    for (const box of checks.values()) box.classList.remove('on')
    updateBar()
  })
  bar.querySelector('[data-close]').addEventListener('click', exitSelect)
  bar.querySelector('[data-go]').addEventListener('click', async () => {
    const go = bar.querySelector('[data-go]')
    go.disabled = true
    go.textContent = '抓取中…'
    try {
      await chrome.runtime.sendMessage({ type: 'capture_many', items: [...selected.values()] })
    } catch {}
    exitSelect()
  })

  // 页面右下角常驻入口（低干扰，不遮正文）
  const launcher = document.createElement('button')
  launcher.className = 'hint'
  launcher.style.display = 'flex'
  launcher.style.left = 'auto'
  launcher.style.right = '16px'
  launcher.style.bottom = '16px'
  launcher.style.top = 'auto'
  launcher.title = '批量抓取本页图片/视频到 FalconMM Inbox'
  launcher.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16v16H4z"/><path d="M8 8h2v2H8zM14 8h2v2h-2zM8 14h8"/></svg>'
  launcher.addEventListener('click', () => (selecting ? exitSelect() : enterSelect()))
  shadow.appendChild(launcher)
})()
