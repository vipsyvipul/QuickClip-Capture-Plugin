import { App, TFile } from 'obsidian'
import { loadIndex, deleteClip } from '../clipsIndex'

type KnownPlatform = 'youtube' | 'vimeo'
interface ParsedVideo { platform: KnownPlatform; videoId: string }

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

export function injectVideoClipView(app: App, containerEl: HTMLElement, filePath: string, confirmDelete: () => boolean): void {
    if (!filePath) return
    const tfile = app.vault.getAbstractFileByPath(filePath)
    if (!(tfile instanceof TFile)) return

    const frontmatter = app.metadataCache.getFileCache(tfile)?.frontmatter
    if (frontmatter?.['clip_type'] !== 'video-clip') return

    const url: string = frontmatter.url
    if (!url) return

    const section = containerEl.querySelector('.markdown-preview-section')
    if (!section) return
    if (section.querySelector('.qc-video-wrap')) return // already injected

    const table = Array.from(section.querySelectorAll('table')).find(
        t => t.querySelector('th')?.textContent?.trim().toLowerCase() === 'time'
    ) as HTMLTableElement | undefined
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
        transformTable(app, containerEl, table, filePath, url, confirmDelete, iframe, parsed.platform)

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
        const hostname = safeHostname(url)
        wrap.addClass('qc-video-wrap--fallback')
        wrap.createEl('a', {
            cls: 'qc-video-fallback-link',
            text: `▶ Watch on ${hostname}`,
            attr: { href: url, target: '_blank', rel: 'noopener' },
        })
        table.parentElement!.insertBefore(wrap, table)
        transformTable(app, containerEl, table, filePath, url, confirmDelete, null, null)
    }
}

function transformTable(
    app: App,
    containerEl: HTMLElement,
    table: HTMLTableElement,
    filePath: string,
    videoUrl: string,
    confirmDelete: () => boolean,
    iframe: HTMLIFrameElement | null,
    platform: KnownPlatform | null,
): void {
    table.addClass('qc-video-table')

    const headers = Array.from(table.querySelectorAll('th')).map(
        th => th.textContent?.trim().toLowerCase() ?? ''
    )
    const timeIdx     = headers.indexOf('time')
    const timelineIdx = headers.indexOf('clip timeline')
    const tagsIdx     = headers.indexOf('tags')

    // Add Delete + sort headers
    const headerRow = table.querySelector('thead tr') ?? table.querySelector('tr')
    let timeTh: HTMLElement | null = null
    let timelineTh: HTMLElement | null = null
    if (headerRow) {
        const ths = Array.from(headerRow.querySelectorAll('th'))
        timeTh = ths[timeIdx] ?? null
        timelineTh = ths[timelineIdx] ?? null
        headerRow.createEl('th', { cls: 'qc-th-delete', text: 'Delete' })
    }

    // Track sort state
    let sortCol: 'time' | 'timeline' | null = null
    let sortAsc = true

    function sortRows(col: 'time' | 'timeline') {
        if (sortCol === col) sortAsc = !sortAsc
        else { sortCol = col; sortAsc = true }

        const tbody = table.querySelector('tbody')
        if (!tbody) return
        const rows = Array.from(tbody.querySelectorAll<HTMLTableRowElement>('tr'))
        rows.sort((a, b) => {
            const av = col === 'time'
                ? parseFloat(a.dataset.sortTime ?? '0')
                : parseFloat(a.dataset.sortTimeline ?? '0')
            const bv = col === 'time'
                ? parseFloat(b.dataset.sortTime ?? '0')
                : parseFloat(b.dataset.sortTimeline ?? '0')
            return sortAsc ? av - bv : bv - av
        })
        rows.forEach(r => tbody.appendChild(r))

        // Update header indicators
        ;[timeTh, timelineTh].forEach(th => { th?.classList.remove('qc-sorted'); th?.removeAttribute('data-sort-dir') })
        const activeTh = col === 'time' ? timeTh : timelineTh
        activeTh?.classList.add('qc-sorted')
        activeTh?.setAttribute('data-sort-dir', sortAsc ? 'asc' : 'desc')
    }

    if (timeTh) {
        timeTh.classList.add('qc-sortable')
        timeTh.addEventListener('click', () => sortRows('time'))
    }
    if (timelineTh) {
        timelineTh.classList.add('qc-sortable')
        timelineTh.addEventListener('click', () => sortRows('timeline'))
    }

    for (const row of Array.from(table.querySelectorAll<HTMLTableRowElement>('tbody tr'))) {
        const cells = Array.from(row.querySelectorAll('td'))

        // Store raw timeline for delete matching and sort
        const rawTimeline = timelineIdx >= 0 && cells[timelineIdx]
            ? cells[timelineIdx].textContent?.trim() ?? ''
            : ''
        row.dataset.sortTimeline = String(parseClipDate(rawTimeline))

        if (timeIdx >= 0 && cells[timeIdx]) {
            const link = cells[timeIdx].querySelector('a')
            const seconds = link ? extractSeconds(link.href, platform) : NaN
            const label = link?.textContent?.trim() ?? ''
            row.dataset.sortTime = String(isNaN(seconds) ? 0 : seconds)
            cells[timeIdx].empty()
            if (!isNaN(seconds) && (iframe || videoUrl)) {
                const chip = cells[timeIdx].createEl('span', {
                    cls: 'qc-timestamp-chip',
                    text: `▶ ${label}`,
                    attr: { title: 'Jump to this moment' },
                })
                chip.addEventListener('click', () => {
                    if (iframe && platform) seekVideo(iframe, platform, seconds)
                    else window.open(videoUrl, '_blank')
                })
            } else if (link) {
                cells[timeIdx].appendChild(link.cloneNode(true))
            }
        }

        if (timelineIdx >= 0 && cells[timelineIdx]) {
            if (rawTimeline) cells[timelineIdx].textContent = formatClipDate(rawTimeline)
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

        // Delete button
        const deleteTd = row.createEl('td', { cls: 'qc-cell qc-cell--delete' })
        const deleteBtn = deleteTd.createEl('button', {
            cls: 'qc-delete-btn qc-card-delete-btn',
            text: '×',
            attr: { title: 'Delete clip' },
        })
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            if (confirmDelete() && !window.confirm('Delete this clip?')) return
            const index = await loadIndex(app)
            let matchUrl = ''
            let matchHash = ''
            outer: for (const [url, entry] of Object.entries(index)) {
                for (const clip of entry.clips) {
                    if (clip.path === filePath && fmtTimeline(clip.savedAt) === rawTimeline) {
                        matchUrl = url
                        matchHash = clip.hash
                        break outer
                    }
                }
            }
            if (!matchHash) return
            await deleteClip(app, matchUrl, matchHash)
            row.remove()
            // Obsidian re-renders the file after vault.modify — re-inject the video once it settles
            setTimeout(() => injectVideoClipView(app, containerEl, filePath, confirmDelete), 300)
        })
    }
}

// Format savedAt to match DOM-rendered "Clip Timeline" text: "26 May 2026 | 15:30"
function fmtTimeline(savedAt: string): string {
    const d = new Date(savedAt)
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} | ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

// Parse Clip Timeline text to a Unix timestamp for sorting
function parseClipDate(raw: string): number {
    const m = raw.match(/(\d{1,2})\s+(\w+)\s+(\d{4})\s*\|\s*(\d{2}):(\d{2})/)
    if (!m) return 0
    const monthIdx = MONTHS.indexOf(m[2])
    if (monthIdx === -1) return 0
    return new Date(parseInt(m[3]), monthIdx, parseInt(m[1]), parseInt(m[4]), parseInt(m[5])).getTime()
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

function extractSeconds(href: string, platform: KnownPlatform | null): number {
    try {
        if (platform === 'vimeo') {
            const m = href.match(/#t=(\d+)s?/)
            return m ? parseInt(m[1], 10) : NaN
        }
        const t = new URL(href).searchParams.get('t')
        return t ? parseInt(t, 10) : NaN
    } catch { return NaN }
}

function safeHostname(url: string): string {
    try { return new URL(url).hostname } catch { return url }
}

// Clip Timeline cell contains "26 May 2026 | 15:30" — reformat to "26 May · 15:30"
function formatClipDate(raw: string): string {
    const m = raw.match(/(\d{1,2}\s+\w+\s+\d{4})\s*\|\s*(\d{2}:\d{2})/)
    if (!m) return raw
    const parts = m[1].split(/\s+/)
    return `${parts[0]} ${parts[1]} · ${m[2]}`
}
