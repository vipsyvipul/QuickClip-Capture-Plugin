import { App, MarkdownPostProcessorContext, MarkdownRenderChild, MarkdownRenderer, setIcon } from 'obsidian'
import { loadIndex, deleteClip } from '../clipsIndex'

export function processHighlight(app: App, el: HTMLElement, ctx: MarkdownPostProcessorContext, confirmDelete: () => boolean): void {
    if (el.closest('.cm-editor')) return
    if (!el.querySelector('[data-callout="quote"], [data-callout="clip"]')) return
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
            transformSection(this.app, this.sourcePath, this.confirmDelete, this.containerEl)
        }
        tryTransform()
    }
}

function transformSection(app: App, sourcePath: string, confirmDelete: () => boolean, calloutSection: HTMLElement): void {
    if (calloutSection.querySelector('.qc-highlight-card')) return
    if (calloutSection.dataset.qcBuilding) return

    const callout = calloutSection.querySelector<HTMLElement>('[data-callout="quote"], [data-callout="clip"]')
    if (!callout) return

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
    const sections = Array.from(container.querySelectorAll('[data-callout="quote"], [data-callout="clip"]'))
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
    'tweet':         { cls: 'qc-badge-tweet',         icon: 'twitter',     label: 'Tweet' },
    'image':         { cls: 'qc-badge-image',         icon: 'image',       label: 'Image' },
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
    }

    delete calloutSection.dataset.qcBuilding

    const badgeCfg = BADGE[clipType] ?? BADGE['highlight']

    // Quote block
    const quoteBlock = document.createElement('div')
    quoteBlock.className = 'qc-quote-block'

    const quoteIcon = document.createElement('span')
    quoteIcon.className = 'qc-quote-icon'
    quoteIcon.textContent = '❝'

    const quoteEl = document.createElement('div')
    quoteEl.className = 'qc-highlight-quote'
    quoteEl.innerHTML = contentEl.innerHTML

    const hasOnlyImage = !!(quoteEl.querySelector('img')) && (quoteEl.textContent?.trim() ?? '') === ''
    if (hasOnlyImage) quoteEl.classList.add('qc-highlight-quote--image')

    quoteBlock.appendChild(quoteIcon)
    quoteBlock.appendChild(quoteEl)

    // Footer
    const footer = document.createElement('div')
    footer.className = 'qc-highlight-footer'

    if (tags.length) {
        const sep1 = document.createElement('hr')
        sep1.className = 'qc-sep'
        const tagsEl = document.createElement('div')
        tagsEl.className = 'qc-highlight-tags'
        tags.forEach(tag => {
            const chip = document.createElement('a')
            chip.className = 'tag'
            chip.textContent = tag
            chip.href = tag
            tagsEl.appendChild(chip)
        })
        footer.appendChild(sep1)
        footer.appendChild(tagsEl)
    }

    const sep2 = document.createElement('hr')
    sep2.className = 'qc-sep'

    const actionsEl = document.createElement('div')
    actionsEl.className = 'qc-highlight-actions'

    // Left group: badge + source link + optional page number
    const leftGroup = document.createElement('div')
    leftGroup.className = 'qc-highlight-actions-left'

    const badge = document.createElement('span')
    badge.className = `qc-clip-badge ${badgeCfg.cls}`
    const iconEl = document.createElement('span')
    iconEl.className = 'qc-badge-icon'
    setIcon(iconEl, badgeCfg.icon)
    badge.appendChild(iconEl)
    badge.appendChild(document.createTextNode(badgeCfg.label))
    leftGroup.appendChild(badge)

    if (isPdf) {
        if (sourceHref) {
            const link = document.createElement('a')
            link.href = sourceHref
            link.className = 'qc-view-link external-link'
            link.textContent = sourceLabel || 'Open PDF ↗'
            link.target = '_blank'
            link.rel = 'noopener'
            leftGroup.appendChild(link)
        } else if (sourceLabel) {
            const localEl = document.createElement('span')
            localEl.className = 'qc-captured'
            localEl.textContent = sourceLabel
            leftGroup.appendChild(localEl)
        }
        if (pageNum) {
            const pageEl = document.createElement('span')
            pageEl.className = 'qc-pdf-page'
            pageEl.textContent = `p. ${pageNum}`
            leftGroup.appendChild(pageEl)
        }
    } else if (viewHref) {
        const link = document.createElement('a')
        link.href = viewHref
        link.className = 'qc-view-link external-link'
        link.textContent = 'View at source ↗'
        link.target = '_blank'
        link.rel = 'noopener'
        leftGroup.appendChild(link)
    }

    actionsEl.appendChild(leftGroup)

    const rightGroup = document.createElement('div')
    rightGroup.className = 'qc-highlight-actions-right'

    if (captured) {
        const capturedEl = document.createElement('span')
        capturedEl.className = 'qc-captured'
        capturedEl.textContent = captured
        rightGroup.appendChild(capturedEl)

        const pipeSep = document.createElement('span')
        pipeSep.className = 'qc-footer-pipe'
        pipeSep.textContent = '|'
        rightGroup.appendChild(pipeSep)

        const deleteBtn = document.createElement('button')
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

    const card = document.createElement('div')
    card.className = 'qc-highlight-card'

    if (noteSection) {
        const noteCallout = noteSection.querySelector('[data-callout="note"]')
        if (noteCallout) {
            const cloned = noteCallout.cloneNode(true) as HTMLElement
            cloned.classList.add('qc-note-callout')

            // Remove "Note" title text
            cloned.querySelector('.callout-title-inner')?.remove()

            // Move content nodes inline into the title (after the icon)
            const calloutTitle = cloned.querySelector<HTMLElement>('.callout-title')
            const calloutContent = cloned.querySelector<HTMLElement>('.callout-content')
            if (calloutTitle && calloutContent) {
                Array.from(calloutContent.childNodes).forEach(n => calloutTitle.appendChild(n))
                calloutContent.remove()
            }

            card.appendChild(cloned)
        }
        noteSection.style.display = 'none'
    }

    if (clipType === 'tweet' && clipUrl) {
        const embedEl = document.createElement('div')
        embedEl.className = 'qc-tweet-embed'
        const embedComponent = new MarkdownRenderChild(embedEl)
        await MarkdownRenderer.render(app, `![](${clipUrl})`, embedEl, sourcePath, embedComponent)
        card.appendChild(embedEl)
    } else {
        card.appendChild(quoteBlock)
    }
    card.appendChild(footer)

    calloutSection.innerHTML = ''
    calloutSection.appendChild(card)
    tableSection.classList.add('qc-table-hidden')
    tableSection.style.display = 'none'
}
