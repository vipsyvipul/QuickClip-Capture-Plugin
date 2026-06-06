import { App, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownRenderer, setIcon } from 'obsidian'
import { loadIndex, deleteClip, invalidateIndexCache } from '../clipsIndex'

const X_ICON_ID = 'qc-x-brand'

export function processHighlight(app: App, el: HTMLElement, ctx: MarkdownPostProcessorContext, confirmDelete: () => boolean): void {
    if (el.closest('.cm-editor')) return
    if (!el.querySelector('[data-callout="quote"], [data-callout="clip"], [data-callout^="qc_"]')) return
    ctx.addChild(new HighlightScanner(el, app, ctx.sourcePath, confirmDelete))
}

class HighlightScanner extends MarkdownRenderChild {
    constructor(el: HTMLElement, private app: App, private sourcePath: string, private confirmDelete: () => boolean) {
        super(el)
    }

    onload(): void {
        const tryTransform = () => {
            if (!this.containerEl.parentElement) {
                requestAnimationFrame(tryTransform)
                return
            }
            // Only render in Reading view — Live Preview mounts callouts outside
            // .markdown-reading-view (inside .cm-editor), so this acts as the guard
            if (!this.containerEl.closest('.markdown-reading-view')) return
            transformSection(this.app, this.sourcePath, this.confirmDelete, this.containerEl)
        }
        tryTransform()
    }
}

function transformSection(app: App, sourcePath: string, confirmDelete: () => boolean, calloutSection: HTMLElement): void {
    if (calloutSection.querySelector('.qc-highlight-card')) return
    if (calloutSection.dataset.qcBuilding) return

    const callout = calloutSection.querySelector<HTMLElement>('[data-callout="quote"], [data-callout="clip"], [data-callout^="qc_"]')
    if (!callout) return

    // New format: metadata is nested inside the callout — no sibling table needed
    if ((callout.dataset.callout ?? '').startsWith('qc_')) {
        // qc_note and qc_details are meta callouts, never standalone cards
        const ct = callout.dataset.callout ?? ''
        if (ct === 'qc_note' || ct === 'qc_details') return
        buildCardV2(app, sourcePath, confirmDelete, calloutSection, callout)
        return
    }

    // Old format: metadata lives in the sibling table section
    const tableSection = calloutSection.nextElementSibling as HTMLElement | null
    if (!tableSection) return

    const table = tableSection.querySelector('table')
    if (!table) return

    const rows = Array.from(table.querySelectorAll('tr'))
    const hasCaptured = rows.some(r => (r.cells[0]?.textContent?.trim() ?? '') === 'Captured')
    if (!hasCaptured) return

    const prevSection = calloutSection.previousElementSibling as HTMLElement | null
    const noteSection = prevSection?.querySelector('[data-callout="note"]') ? prevSection : null

    buildCard(app, sourcePath, confirmDelete, calloutSection, tableSection, callout, table as HTMLTableElement, noteSection)
}

// Called from main.ts on active-leaf-change to re-apply after Obsidian cache resets
export function scanAndTransform(app: App, container: HTMLElement, sourcePath: string, confirmDelete: () => boolean): void {
    const sections = Array.from(container.querySelectorAll('[data-callout="quote"], [data-callout="clip"], [data-callout^="qc_"]'))
    sections.forEach(callout => {
        const section = callout.closest('.el-div, .el-blockquote, div') as HTMLElement | null
        if (section && section.parentElement === container) {
            transformSection(app, sourcePath, confirmDelete, section)
        }
    })
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function fmtDate(savedAt: string): string {
    const d = new Date(savedAt)
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} · ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function safeDecode(s: string): string {
    try { return decodeURIComponent(s) } catch { return s }
}

type BadgeCfg = { cls: string; icon: string; label: string }
const BADGE: Record<string, BadgeCfg> = {
    'highlight':     { cls: 'qc-badge-highlight',     icon: 'highlighter', label: 'Highlight' },
    'pdf-highlight': { cls: 'qc-badge-pdf-highlight', icon: 'file-text',   label: 'PDF' },
    'tweet':         { cls: 'qc-badge-tweet',         icon: X_ICON_ID,     label: 'Tweet' },
    'image':         { cls: 'qc-badge-image',         icon: 'image',       label: 'Image' },
}

const QC_EXPANDED_KEY = 'qc-expanded-clips'
function getExpandedSet(): Set<string> {
    try { return new Set(JSON.parse(localStorage.getItem(QC_EXPANDED_KEY) ?? '[]')) }
    catch { return new Set() }
}
function persistExpanded(key: string, expanded: boolean): void {
    const set = getExpandedSet()
    expanded ? set.add(key) : set.delete(key)
    localStorage.setItem(QC_EXPANDED_KEY, JSON.stringify([...set]))
}

function buildCardHeader(card: HTMLElement, badgeCfg: BadgeCfg, summaryText: string, persistKey: string): void {
    const cardHeader = activeDocument.createElement('div')
    cardHeader.className = 'qc-card-header'
    const chevronEl = activeDocument.createElement('span')
    chevronEl.className = 'qc-card-chevron'
    setIcon(chevronEl, 'chevron-down')
    const iconEl = activeDocument.createElement('span')
    iconEl.className = 'qc-card-header-icon'
    setIcon(iconEl, badgeCfg.icon)
    const headerSummary = activeDocument.createElement('span')
    headerSummary.className = 'qc-card-header-summary'
    headerSummary.textContent = summaryText ? `${badgeCfg.label} — ${summaryText}` : badgeCfg.label
    cardHeader.appendChild(chevronEl)
    cardHeader.appendChild(iconEl)
    cardHeader.appendChild(headerSummary)
    cardHeader.addEventListener('click', () => {
        const nowCollapsed = card.classList.toggle('qc-card-collapsed')
        persistExpanded(persistKey, !nowCollapsed)
    })
    card.appendChild(cardHeader)
}

async function buildCard(
    app: App,
    sourcePath: string,
    confirmDelete: () => boolean,
    calloutSection: HTMLElement,
    tableSection: HTMLElement,
    callout: HTMLElement,
    table: HTMLTableElement,
    noteSection: HTMLElement | null
): Promise<void> {
    calloutSection.dataset.qcBuilding = '1'

    const contentEl = callout.querySelector('.callout-content')
    if (!contentEl) { delete calloutSection.dataset.qcBuilding; return }

    let viewHref = ''
    let sourceHref = ''
    let sourceLabel = ''
    let pageNum = ''
    let captured = ''
    const tags: string[] = []
    let isPdf = false

    for (const row of Array.from(table.querySelectorAll('tr'))) {
        const key = row.cells[0]?.textContent?.trim() ?? ''
        const valueCell = row.cells[1]

        if (key === 'Open') {
            viewHref = valueCell?.querySelector('a')?.href ?? ''
        } else if (key === 'Source') {
            isPdf = true
            const link = valueCell?.querySelector('a')
            if (link) {
                sourceHref = link.href
                sourceLabel = safeDecode(link.textContent?.trim() ?? '')
            } else {
                sourceLabel = safeDecode(valueCell?.textContent?.trim() ?? '')
            }
        } else if (key === 'Page') {
            pageNum = valueCell?.textContent?.trim() ?? ''
        } else if (key === 'Captured') {
            captured = (valueCell?.textContent?.trim() ?? '').replace(' | ', ' · ')
        } else if (key === 'Tags') {
            valueCell?.textContent?.split(/\s+/).filter(Boolean).forEach(t => tags.push(t))
        }
    }

    // Resolve clip_type and URL from the index
    let clipType = isPdf ? 'pdf-highlight' : 'highlight'
    let clipUrl = ''
    if (captured) {
        const index = await loadIndex(app)
        outer: for (const [url, entry] of Object.entries(index)) {
            for (const c of entry.clips) {
                if (fmtDate(c.savedAt) === captured && c.path === sourcePath) {
                    clipType = c.clip_type
                    clipUrl = url
                    break outer
                }
            }
        }
        // If not found, the cache was populated before clipsHistory.json was updated
        // (extension writes .md then clipsHistory.json — re-render fires on the .md write).
        // Invalidate and retry once with a fresh read.
        if (!clipUrl) {
            invalidateIndexCache()
            const fresh = await loadIndex(app)
            retry: for (const [url, entry] of Object.entries(fresh)) {
                for (const c of entry.clips) {
                    if (fmtDate(c.savedAt) === captured && c.path === sourcePath) {
                        clipType = c.clip_type
                        clipUrl = url
                        break retry
                    }
                }
            }
        }
    }

    delete calloutSection.dataset.qcBuilding

    const badgeCfg = BADGE[clipType] ?? BADGE['highlight']

    // Quote block
    const quoteBlock = activeDocument.createElement('div')
    quoteBlock.className = 'qc-quote-block'

    const quoteIcon = activeDocument.createElement('span')
    quoteIcon.className = 'qc-quote-icon'
    quoteIcon.textContent = '❝'

    const quoteEl = activeDocument.createElement('div')
    quoteEl.className = 'qc-highlight-quote'
    Array.from(contentEl.childNodes).forEach(n => quoteEl.appendChild(n.cloneNode(true)))

    const hasOnlyImage = !!(quoteEl.querySelector('img')) && (quoteEl.textContent?.trim() ?? '') === ''
    if (hasOnlyImage) quoteEl.classList.add('qc-highlight-quote--image')

    quoteBlock.appendChild(quoteIcon)
    quoteBlock.appendChild(quoteEl)

    // Footer
    const footer = activeDocument.createElement('div')
    footer.className = 'qc-highlight-footer'

    if (tags.length) {
        const sep1 = activeDocument.createElement('hr')
        sep1.className = 'qc-sep'
        const tagsEl = activeDocument.createElement('div')
        tagsEl.className = 'qc-highlight-tags'
        tags.forEach(tag => {
            const chip = activeDocument.createElement('a')
            chip.className = 'tag'
            chip.textContent = tag
            chip.href = tag
            tagsEl.appendChild(chip)
        })
        footer.appendChild(sep1)
        footer.appendChild(tagsEl)
    }

    const sep2 = activeDocument.createElement('hr')
    sep2.className = 'qc-sep'

    const actionsEl = activeDocument.createElement('div')
    actionsEl.className = 'qc-highlight-actions'

    // Left group: badge + source link + optional page number
    const leftGroup = activeDocument.createElement('div')
    leftGroup.className = 'qc-highlight-actions-left'

    const badge = activeDocument.createElement('span')
    badge.className = `qc-clip-badge ${badgeCfg.cls}`
    const iconEl = activeDocument.createElement('span')
    iconEl.className = 'qc-badge-icon'
    setIcon(iconEl, badgeCfg.icon)
    badge.appendChild(iconEl)
    badge.appendChild(activeDocument.createTextNode(badgeCfg.label))
    leftGroup.appendChild(badge)

    if (isPdf) {
        if (sourceHref) {
            const link = activeDocument.createElement('a')
            link.href = sourceHref
            link.className = 'qc-view-link external-link'
            link.textContent = sourceLabel || 'Open PDF ↗'
            link.target = '_blank'
            link.rel = 'noopener'
            leftGroup.appendChild(link)
        } else if (sourceLabel) {
            if (clipUrl?.startsWith('file://')) {
                const link = activeDocument.createElement('a')
                link.className = 'qc-view-link external-link'
                link.textContent = sourceLabel
                link.href = clipUrl
                link.target = '_blank'
                link.rel = 'noopener'
                leftGroup.appendChild(link)
            } else {
                const localEl = activeDocument.createElement('span')
                localEl.className = 'qc-captured'
                localEl.textContent = sourceLabel
                leftGroup.appendChild(localEl)
            }
        }
        if (pageNum) {
            const pageEl = activeDocument.createElement('span')
            pageEl.className = 'qc-pdf-page'
            pageEl.textContent = `p. ${pageNum}`
            leftGroup.appendChild(pageEl)
        }
    } else if (viewHref) {
        const link = activeDocument.createElement('a')
        link.href = viewHref
        link.className = 'qc-view-link external-link'
        link.textContent = clipType === 'tweet' ? 'View tweet ↗' : 'View with highlight ↗'
        link.target = '_blank'
        link.rel = 'noopener'
        leftGroup.appendChild(link)
    }

    actionsEl.appendChild(leftGroup)

    const rightGroup = activeDocument.createElement('div')
    rightGroup.className = 'qc-highlight-actions-right'

    if (captured) {
        const capturedEl = activeDocument.createElement('span')
        capturedEl.className = 'qc-captured'
        capturedEl.textContent = captured
        rightGroup.appendChild(capturedEl)

        const pipeSep = activeDocument.createElement('span')
        pipeSep.className = 'qc-footer-pipe'
        pipeSep.textContent = '|'
        rightGroup.appendChild(pipeSep)

        const deleteBtn = activeDocument.createElement('button')
        deleteBtn.className = 'qc-delete-btn qc-card-delete-btn'
        deleteBtn.textContent = '×'
        deleteBtn.title = 'Delete clip'
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            if (confirmDelete() && !window.confirm('Delete this clip?')) return
            const index = await loadIndex(app)
            // Find clip by file path + captured date — more reliable than URL matching
            let matchUrl = ''
            let match = null
            for (const [url, entry] of Object.entries(index)) {
                const clip = entry.clips.find(c => fmtDate(c.savedAt) === captured && c.path === sourcePath)
                if (clip) { matchUrl = url; match = clip; break }
            }
            if (!match) return
            await deleteClip(app, matchUrl, match.hash)
            const sep = tableSection.nextElementSibling
            noteSection?.remove()
            calloutSection.remove()
            tableSection.remove()
            if (sep?.tagName === 'HR') sep.remove()
        })
        rightGroup.appendChild(deleteBtn)
    }

    actionsEl.appendChild(rightGroup)

    footer.appendChild(sep2)
    footer.appendChild(actionsEl)

    const card = activeDocument.createElement('div')
    card.className = 'qc-highlight-card'

    const persistKey = `${sourcePath}::${captured}`
    if (!getExpandedSet().has(persistKey)) card.classList.add('qc-card-collapsed')
    const raw = quoteEl.textContent?.trim() ?? ''
    buildCardHeader(card, badgeCfg, raw.length > 60 ? raw.slice(0, 60) + '…' : raw, persistKey)

    const cardBody = activeDocument.createElement('div')
    cardBody.className = 'qc-card-body'

    if (noteSection) {
        const noteCallout = noteSection.querySelector('[data-callout="note"]')
        if (noteCallout) {
            const cloned = noteCallout.cloneNode(true) as HTMLElement
            cloned.classList.add('qc-note-callout')

            // Remove "Note" title text
            cloned.querySelector('.callout-title-inner')?.remove()
            const iconEl = cloned.querySelector<HTMLElement>('.callout-icon')
            if (iconEl) setIcon(iconEl, 'message-circle')

            // Move content nodes inline into the title (after the icon)
            const calloutTitle = cloned.querySelector<HTMLElement>('.callout-title')
            const calloutContent = cloned.querySelector<HTMLElement>('.callout-content')
            if (calloutTitle && calloutContent) {
                Array.from(calloutContent.childNodes).forEach(n => calloutTitle.appendChild(n))
                calloutContent.remove()
            }

            cardBody.appendChild(cloned)
        }
    }

    let tweetEmbedEl: HTMLElement | null = null
    if (clipType === 'tweet' && clipUrl) {
        tweetEmbedEl = activeDocument.createElement('div')
        tweetEmbedEl.className = 'qc-tweet-embed'
        cardBody.appendChild(tweetEmbedEl)
    } else {
        cardBody.appendChild(quoteBlock)
    }
    cardBody.appendChild(footer)
    card.appendChild(cardBody)

    // Save scroll position before any DOM mutations so the browser's scroll
    // anchor algorithm can't snap the view when content height changes.
    const scrollEl = calloutSection.closest('.markdown-preview-view') as HTMLElement | null
    const savedScrollTop = scrollEl?.scrollTop

    calloutSection.empty()
    calloutSection.appendChild(card)
    tableSection.classList.add('qc-table-hidden')
    if (noteSection) noteSection.addClass('is-hidden')

    if (scrollEl && savedScrollTop !== undefined) scrollEl.scrollTop = savedScrollTop

    // Render tweet embed now that embedEl is attached to the live DOM
    if (tweetEmbedEl && clipUrl) {
        const embedComponent = new MarkdownRenderChild(tweetEmbedEl)
        await MarkdownRenderer.render(app, `![](${clipUrl})`, tweetEmbedEl, sourcePath, embedComponent)
    }
}

const CALLOUT_TO_CLIP_TYPE: Record<string, string> = {
    'qc_highlight':     'highlight',
    'qc_tweet':         'tweet',
    'qc_pdf_highlight': 'pdf-highlight',
    'qc_image':         'image',
}

async function buildCardV2(
    app: App,
    sourcePath: string,
    confirmDelete: () => boolean,
    calloutSection: HTMLElement,
    callout: HTMLElement
): Promise<void> {
    calloutSection.dataset.qcBuilding = '1'

    const clipType = CALLOUT_TO_CLIP_TYPE[callout.dataset.callout ?? ''] ?? 'highlight'

    const contentEl = callout.querySelector<HTMLElement>('.callout-content')
    if (!contentEl) { delete calloutSection.dataset.qcBuilding; return }

    const detailsCallout = contentEl.querySelector<HTMLElement>('[data-callout="qc_details"]')
    const noteCallout    = contentEl.querySelector<HTMLElement>('[data-callout="qc_note"]')

    // Extract metadata from qc_details table
    let captured = '', hash = '', viewHref = '', sourceHref = '', sourceLabel = '', pageNum = ''
    const tags: string[] = []

    if (detailsCallout) {
        for (const row of Array.from(detailsCallout.querySelectorAll('tr'))) {
            const key       = row.cells[0]?.textContent?.trim() ?? ''
            const valueCell = row.cells[1]
            if      (key === 'Captured')       captured    = (valueCell?.textContent?.trim() ?? '').replace(' | ', ' · ')
            else if (key === 'Tags')           valueCell?.textContent?.split(/\s+/).filter(Boolean).forEach(t => tags.push(t))
            else if (key === 'QuickClip Hash') hash        = valueCell?.textContent?.trim() ?? ''
            else if (key === 'Source') {
                const link = valueCell?.querySelector('a')
                if (link) { sourceHref = link.href; sourceLabel = safeDecode(link.textContent?.trim() ?? '') }
                else        sourceLabel = safeDecode(valueCell?.textContent?.trim() ?? '')
            }
            else if (key === 'Page')           pageNum     = valueCell?.textContent?.trim() ?? ''
        }
    }

    // Extract source link from body: a <p> whose only non-whitespace child is an <a>
    for (const child of Array.from(contentEl.children)) {
        if (child.matches('[data-callout^="qc_"]')) break
        if (child.tagName === 'P') {
            const sig = Array.from(child.childNodes).filter(n => n.nodeType !== Node.TEXT_NODE || n.textContent?.trim())
            if (sig.length === 1 && (sig[0] as Element).tagName === 'A') {
                viewHref = (sig[0] as HTMLAnchorElement).href
            }
        }
    }

    // Look up clip URL from index by hash
    let clipUrl = ''
    if (hash) {
        const index = await loadIndex(app)
        outer: for (const [url, entry] of Object.entries(index)) {
            for (const c of entry.clips) {
                if (c.hash === hash) { clipUrl = url; break outer }
            }
        }
        if (!clipUrl) {
            invalidateIndexCache()
            const fresh = await loadIndex(app)
            retry: for (const [url, entry] of Object.entries(fresh)) {
                for (const c of entry.clips) {
                    if (c.hash === hash) { clipUrl = url; break retry }
                }
            }
        }
    }

    delete calloutSection.dataset.qcBuilding

    const badgeCfg = BADGE[clipType] ?? BADGE['highlight']

    // Build quote block: body children that are not nested callouts or the source link paragraph
    const quoteContentEl = activeDocument.createElement('div')
    quoteContentEl.className = 'qc-highlight-quote'
    for (const child of Array.from(contentEl.children)) {
        if (child.matches('[data-callout^="qc_"]')) break
        if (child.tagName === 'P') {
            const sig = Array.from(child.childNodes).filter(n => n.nodeType !== Node.TEXT_NODE || n.textContent?.trim())
            if (sig.length === 1 && (sig[0] as Element).tagName === 'A') continue
        }
        quoteContentEl.appendChild(child.cloneNode(true))
    }
    const hasOnlyImage = !!(quoteContentEl.querySelector('img')) && (quoteContentEl.textContent?.trim() ?? '') === ''
    if (hasOnlyImage) quoteContentEl.classList.add('qc-highlight-quote--image')

    const quoteIcon = activeDocument.createElement('span')
    quoteIcon.className = 'qc-quote-icon'
    quoteIcon.textContent = '❝'

    const quoteBlock = activeDocument.createElement('div')
    quoteBlock.className = 'qc-quote-block'
    quoteBlock.appendChild(quoteIcon)
    quoteBlock.appendChild(quoteContentEl)

    // Footer
    const footer = activeDocument.createElement('div')
    footer.className = 'qc-highlight-footer'

    if (tags.length) {
        const sep1 = activeDocument.createElement('hr'); sep1.className = 'qc-sep'
        const tagsEl = activeDocument.createElement('div'); tagsEl.className = 'qc-highlight-tags'
        tags.forEach(tag => {
            const chip = activeDocument.createElement('a')
            chip.className = 'tag'; chip.textContent = tag; chip.href = tag
            tagsEl.appendChild(chip)
        })
        footer.appendChild(sep1)
        footer.appendChild(tagsEl)
    }

    const sep2 = activeDocument.createElement('hr'); sep2.className = 'qc-sep'
    const actionsEl = activeDocument.createElement('div'); actionsEl.className = 'qc-highlight-actions'

    const leftGroup = activeDocument.createElement('div'); leftGroup.className = 'qc-highlight-actions-left'
    const badge = activeDocument.createElement('span'); badge.className = `qc-clip-badge ${badgeCfg.cls}`
    const iconEl = activeDocument.createElement('span'); iconEl.className = 'qc-badge-icon'
    setIcon(iconEl, badgeCfg.icon)
    badge.appendChild(iconEl)
    badge.appendChild(activeDocument.createTextNode(badgeCfg.label))
    leftGroup.appendChild(badge)

    const isPdf = clipType === 'pdf-highlight'
    if (isPdf) {
        if (sourceHref) {
            const link = activeDocument.createElement('a')
            link.href = sourceHref; link.className = 'qc-view-link external-link'
            link.textContent = sourceLabel || 'Open PDF ↗'; link.target = '_blank'; link.rel = 'noopener'
            leftGroup.appendChild(link)
        } else if (sourceLabel) {
            if (clipUrl?.startsWith('file://')) {
                const link = activeDocument.createElement('a')
                link.className = 'qc-view-link external-link'
                link.textContent = sourceLabel
                link.href = clipUrl; link.target = '_blank'; link.rel = 'noopener'
                leftGroup.appendChild(link)
            } else {
                const localEl = activeDocument.createElement('span'); localEl.className = 'qc-captured'
                localEl.textContent = sourceLabel; leftGroup.appendChild(localEl)
            }
        }
        if (pageNum) {
            const pageEl = activeDocument.createElement('span'); pageEl.className = 'qc-pdf-page'
            pageEl.textContent = `p. ${pageNum}`; leftGroup.appendChild(pageEl)
        }
    } else if (viewHref) {
        const link = activeDocument.createElement('a')
        link.href = viewHref; link.className = 'qc-view-link external-link'
        link.textContent = clipType === 'tweet' ? 'View tweet ↗' : 'View with highlight ↗'
        link.target = '_blank'; link.rel = 'noopener'
        leftGroup.appendChild(link)
    }
    actionsEl.appendChild(leftGroup)

    const rightGroup = activeDocument.createElement('div'); rightGroup.className = 'qc-highlight-actions-right'
    if (captured) {
        const capturedEl = activeDocument.createElement('span'); capturedEl.className = 'qc-captured'
        capturedEl.textContent = captured; rightGroup.appendChild(capturedEl)
        const pipeSep = activeDocument.createElement('span'); pipeSep.className = 'qc-footer-pipe'
        pipeSep.textContent = '|'; rightGroup.appendChild(pipeSep)
    }
    if (hash) {
        const deleteBtn = activeDocument.createElement('button')
        deleteBtn.className = 'qc-delete-btn qc-card-delete-btn'
        deleteBtn.textContent = '×'; deleteBtn.title = 'Delete clip'
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            if (confirmDelete() && !window.confirm('Delete this clip?')) return
            const index = await loadIndex(app)
            let matchUrl = ''; let matchClip = null
            for (const [url, entry] of Object.entries(index)) {
                const c = entry.clips.find(c => c.hash === hash)
                if (c) { matchUrl = url; matchClip = c; break }
            }
            if (!matchClip) return
            await deleteClip(app, matchUrl, matchClip.hash)
            const sep = calloutSection.nextElementSibling
            calloutSection.remove()
            if (sep?.tagName === 'HR') sep.remove()
        })
        rightGroup.appendChild(deleteBtn)
    }
    actionsEl.appendChild(rightGroup)
    footer.appendChild(sep2)
    footer.appendChild(actionsEl)

    const card = activeDocument.createElement('div'); card.className = 'qc-highlight-card'

    const persistKey = hash || `${sourcePath}::${captured}`
    if (!getExpandedSet().has(persistKey)) card.classList.add('qc-card-collapsed')
    const raw = quoteContentEl.textContent?.trim() ?? ''
    buildCardHeader(card, badgeCfg, raw.length > 60 ? raw.slice(0, 60) + '…' : raw, persistKey)

    const cardBody = activeDocument.createElement('div'); cardBody.className = 'qc-card-body'

    if (noteCallout) {
        const cloned = noteCallout.cloneNode(true) as HTMLElement
        cloned.classList.add('qc-note-callout')
        cloned.querySelector('.callout-title-inner')?.remove()
        const iconEl = cloned.querySelector<HTMLElement>('.callout-icon')
        if (iconEl) setIcon(iconEl, 'message-circle')
        const calloutTitle   = cloned.querySelector<HTMLElement>('.callout-title')
        const calloutContent = cloned.querySelector<HTMLElement>('.callout-content')
        if (calloutTitle && calloutContent) {
            Array.from(calloutContent.childNodes).forEach(n => calloutTitle.appendChild(n))
            calloutContent.remove()
        }
        cardBody.appendChild(cloned)
    }

    let tweetEmbedEl: HTMLElement | null = null
    if (clipType === 'tweet' && clipUrl) {
        tweetEmbedEl = activeDocument.createElement('div'); tweetEmbedEl.className = 'qc-tweet-embed'
        cardBody.appendChild(tweetEmbedEl)
    } else {
        cardBody.appendChild(quoteBlock)
    }
    cardBody.appendChild(footer)
    card.appendChild(cardBody)

    const scrollEl = calloutSection.closest('.markdown-preview-view') as HTMLElement | null
    const savedScrollTop = scrollEl?.scrollTop

    calloutSection.empty()
    calloutSection.appendChild(card)

    if (scrollEl && savedScrollTop !== undefined) scrollEl.scrollTop = savedScrollTop

    if (tweetEmbedEl && clipUrl) {
        const embedComponent = new MarkdownRenderChild(tweetEmbedEl)
        await MarkdownRenderer.render(app, `![](${clipUrl})`, tweetEmbedEl, sourcePath, embedComponent)
    }
}
