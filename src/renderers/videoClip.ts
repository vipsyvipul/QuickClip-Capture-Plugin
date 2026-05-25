import { App, TFile } from 'obsidian'

type KnownPlatform = 'youtube' | 'vimeo'
interface ParsedVideo { platform: KnownPlatform; videoId: string }

export function injectVideoClipView(app: App, containerEl: HTMLElement, filePath: string): void {
    if (!filePath) return
    const tfile = app.vault.getAbstractFileByPath(filePath)
    if (!(tfile instanceof TFile)) return

    const frontmatter = app.metadataCache.getFileCache(tfile)?.frontmatter
    if (frontmatter?.clipType !== 'video-clip') return

    const url: string = frontmatter.url
    if (!url) return

    const section = containerEl.querySelector('.markdown-preview-section')
    if (!section) return
    if (section.querySelector('.qc-video-wrap')) return // already injected

    const table = Array.from(section.querySelectorAll('table')).find(
        t => t.querySelector('th')?.textContent?.trim().toLowerCase() === 'start'
    )
    if (!table) return

    const wrap = createDiv({ cls: 'qc-video-wrap' })
    const parsed = parseVideoUrl(url)

    if (parsed) {
        const iframe = wrap.createEl('iframe', {
            cls: 'qc-video-iframe',
            attr: {
                src: buildEmbedUrl(parsed.videoId, parsed.platform),
                frameborder: '0',
                allowfullscreen: 'true',
                allow: 'autoplay; encrypted-media',
            },
        })
        table.parentElement!.insertBefore(wrap, table)
        transformTable(table, iframe, parsed.platform)

        // Both YouTube and Vimeo report errors via postMessage — handle for both
        const platform = parsed.platform
        const watchLabel = platform === 'vimeo' ? 'Watch on Vimeo ↗' : 'Watch on YouTube ↗'
        const onMessage = (e: MessageEvent) => {
            if (e.source !== iframe.contentWindow) return
            let data: any
            try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data } catch { return }

            let errorInfo: { title: string; sub: string } | null = null
            if (platform === 'youtube' && data?.event === 'onError') {
                errorInfo = youtubeErrorText(data.info)
            } else if (platform === 'vimeo' && data?.event === 'error') {
                errorInfo = vimeoErrorText(data?.data?.name ?? '')
            }
            if (!errorInfo) return

            window.removeEventListener('message', onMessage)
            wrap.innerHTML = ''
            wrap.addClass('qc-video-wrap--blocked')
            const inner = wrap.createDiv({ cls: 'qc-embed-blocked' })
            inner.createEl('span', { cls: 'qc-embed-blocked-title', text: errorInfo.title })
            inner.createEl('span', { cls: 'qc-embed-blocked-sub', text: errorInfo.sub })
            inner.createEl('a', {
                cls: 'qc-video-fallback-link',
                text: watchLabel,
                attr: { href: url, target: '_blank', rel: 'noopener' },
            })
        }
        window.addEventListener('message', onMessage)
    } else {
        // Unsupported platform — show a link instead of a broken iframe
        const hostname = safeHostname(url)
        wrap.addClass('qc-video-wrap--fallback')
        wrap.createEl('a', {
            cls: 'qc-video-fallback-link',
            text: `▶ Watch on ${hostname}`,
            attr: { href: url, target: '_blank', rel: 'noopener' },
        })
        table.parentElement!.insertBefore(wrap, table)
        transformTable(table, null, null, url)
    }
}

function transformTable(
    table: HTMLTableElement,
    iframe: HTMLIFrameElement | null,
    platform: KnownPlatform | null,
    fallbackUrl?: string
): void {
    const headers = Array.from(table.querySelectorAll('th')).map(
        th => th.textContent?.trim().toLowerCase() ?? ''
    )
    const startIdx = headers.indexOf('start')
    const savedIdx = headers.indexOf('saved')
    const tagsIdx  = headers.indexOf('tags')

    for (const row of Array.from(table.querySelectorAll('tbody tr'))) {
        const cells = Array.from(row.querySelectorAll('td'))

        if (startIdx >= 0 && cells[startIdx]) {
            const seconds = parseInt(cells[startIdx].textContent?.trim() ?? '', 10)
            if (!isNaN(seconds)) {
                cells[startIdx].empty()
                const chip = cells[startIdx].createEl('span', {
                    cls: 'qc-timestamp-chip',
                    text: `▶ ${formatSeconds(seconds)}`,
                    attr: { title: 'Jump to this moment' },
                })
                chip.addEventListener('click', () => {
                    if (iframe && platform) seekVideo(iframe, platform, seconds)
                    else if (fallbackUrl) window.open(fallbackUrl, '_blank')
                })
            }
        }

        if (savedIdx >= 0 && cells[savedIdx]) {
            const iso = cells[savedIdx].textContent?.trim() ?? ''
            if (iso) cells[savedIdx].textContent = formatDate(iso)
        }

        if (tagsIdx >= 0 && cells[tagsIdx]) {
            const raw = cells[tagsIdx].textContent?.trim() ?? ''
            if (raw) {
                cells[tagsIdx].empty()
                raw.split(/\s+/).filter(Boolean).forEach(tag => {
                    cells[tagsIdx].createEl('span', { cls: 'qc-tag-chip', text: tag })
                })
            }
        }
    }
}

function parseVideoUrl(url: string): ParsedVideo | null {
    const ytMatch = url.match(
        /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/
    )
    if (ytMatch) return { platform: 'youtube', videoId: ytMatch[1] }

    const vimeoMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/)
    if (vimeoMatch) return { platform: 'vimeo', videoId: vimeoMatch[1] }

    return null
}

function buildEmbedUrl(videoId: string, platform: KnownPlatform): string {
    if (platform === 'vimeo') return `https://player.vimeo.com/video/${videoId}?api=1`
    return `https://www.youtube.com/embed/${videoId}?enablejsapi=1`
}

function seekVideo(iframe: HTMLIFrameElement, platform: KnownPlatform, seconds: number): void {
    if (platform === 'vimeo') {
        iframe.contentWindow?.postMessage(JSON.stringify({ method: 'setCurrentTime', value: seconds }), '*')
    } else {
        iframe.contentWindow?.postMessage(JSON.stringify({ event: 'command', func: 'seekTo', args: [seconds, true] }), '*')
    }
}

function vimeoErrorText(name: string): { title: string; sub: string } {
    switch (name) {
        case 'NotFound':     return { title: 'Video not found', sub: 'This video may have been deleted or doesn\'t exist.' }
        case 'PrivacyError': return { title: 'Private video', sub: 'This video is private.' }
        case 'NotAllowed':   return { title: 'Embedding disabled', sub: 'The owner has restricted playback on external sites.' }
        default:             return { title: 'Video unavailable', sub: 'Vimeo returned a playback error.' }
    }
}

function youtubeErrorText(code: number): { title: string; sub: string } {
    switch (code) {
        case 2:   return { title: 'Broken video link', sub: 'The video ID in this clip\'s URL is invalid.' }
        case 5:   return { title: 'Playback error', sub: 'This video can\'t be played in the browser.' }
        case 100: return { title: 'Video unavailable', sub: 'This video may have been deleted or set to private.' }
        case 101:
        case 150: return { title: 'Embedding disabled', sub: 'The owner has disabled playback on external sites.' }
        default:  return { title: 'Video unavailable', sub: `YouTube returned an error (code ${code}).` }
    }
}

function safeHostname(url: string): string {
    try { return new URL(url).hostname } catch { return url }
}

function formatSeconds(s: number): string {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    return `${m}:${String(sec).padStart(2, '0')}`
}

function formatDate(iso: string): string {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
