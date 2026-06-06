import { App, MarkdownPostProcessorContext, MarkdownRenderChild, TFile, setIcon } from 'obsidian'

type ProgressBar = HTMLElement & { _cleanup?: () => void }

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December']

function formatDate(dateStr: string): string {
    const [year, month, day] = dateStr.split('-').map(Number)
    if (!year || !month || !day) return dateStr
    const suffix = (d: number) => {
        if (d >= 11 && d <= 13) return 'th'
        return ['th','st','nd','rd'][d % 10] ?? 'th'
    }
    return `${day}${suffix(day)} ${MONTHS[month - 1]} ${year}`
}

export function processFullPage(app: App, el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    // Render standalone [!qc_note] in full-page files as a slim annotation bar
    const noteCallout = el.querySelector<HTMLElement>('[data-callout="qc_note"]')
    if (!noteCallout) return

    const file = app.vault.getAbstractFileByPath(ctx.sourcePath)
    if (!(file instanceof TFile)) return
    const meta = app.metadataCache.getFileCache(file)
    if (meta?.frontmatter?.['clip_type'] !== 'full-page') return

    ctx.addChild(new FullPageNoteScanner(el, noteCallout))
}

class FullPageNoteScanner extends MarkdownRenderChild {
    constructor(el: HTMLElement, private noteCallout: HTMLElement) {
        super(el)
    }

    onload(): void {
        const tryRender = () => {
            if (!this.containerEl.parentElement) { requestAnimationFrame(tryRender); return }
            if (!this.containerEl.closest('.markdown-reading-view')) return
            this.render()
        }
        tryRender()
    }

    private render(): void {
        const content = this.noteCallout.querySelector<HTMLElement>('.callout-content')
        if (!content) return

        const bar = activeDocument.createElement('div')
        bar.className = 'qc-fullpage-note'

        const iconEl = activeDocument.createElement('span')
        iconEl.className = 'qc-fullpage-note-icon'
        setIcon(iconEl, 'message-circle')

        const textEl = activeDocument.createElement('div')
        textEl.className = 'qc-fullpage-note-text'
        Array.from(content.childNodes).forEach(n => textEl.appendChild(n.cloneNode(true)))

        bar.appendChild(iconEl)
        bar.appendChild(textEl)

        this.containerEl.empty()
        this.containerEl.appendChild(bar)
    }
}

export function injectFullPageHeader(app: App, container: HTMLElement, sourcePath: string): void {
    // Clean up any previous injection
    const existing = container.querySelector('.qc-reading-progress') as ProgressBar | null
    if (existing?._cleanup) existing._cleanup()
    existing?.remove()
    container.querySelector('.qc-fullpage-header')?.remove()
    container.querySelector('.qc-progress-sentinel')?.remove()

    if (!sourcePath) return
    const file = app.vault.getAbstractFileByPath(sourcePath)
    if (!(file instanceof TFile)) return
    const meta = app.metadataCache.getFileCache(file)
    if (meta?.frontmatter?.['clip_type'] !== 'full-page') return

    const previewView = container.querySelector('.markdown-preview-view') as HTMLElement | null
    if (!previewView) return

    const anchor = previewView.querySelector('.metadata-container') ?? previewView.querySelector('.frontmatter')
    if (anchor) (anchor as HTMLElement).addClass('is-hidden')
    let insertAfter: Element | null = anchor

    // ── Header pills ──────────────────────────────────────────────
    const { author, published, site, word_count } = meta.frontmatter ?? {}
    if (author || published || site || word_count) {
        const header = activeDocument.createElement('div')
        header.className = 'qc-fullpage-header'

        const addPill = (text: string) => {
            const pill = activeDocument.createElement('span')
            pill.className = 'qc-fullpage-pill'
            pill.textContent = text
            header.appendChild(pill)
        }

        if (site) addPill(site)
        if (author) addPill(author)
        if (published) addPill(formatDate(String(published)))
        if (word_count) {
            addPill(`${Number(word_count).toLocaleString()} words`)
            addPill(`${Math.ceil(word_count / 200)} min read`)
        }

        if (anchor) {
            anchor.after(header)
        } else {
            const sizer = previewView.querySelector('.markdown-preview-sizer')
            if (sizer) sizer.prepend(header)
        }
        insertAfter = header
    }

    // ── Sentinel ──────────────────────────────────────────────────
    // Sits in the content flow after the header pills. Obsidian's lazy renderer
    // may remove it when scrolled far enough — that's fine; IntersectionObserver
    // treats removal as "not intersecting" and shows the progress bar correctly.
    const sentinel = activeDocument.createElement('div')
    sentinel.className = 'qc-progress-sentinel'
    if (insertAfter) {
        insertAfter.after(sentinel)
    } else {
        const sizer = previewView.querySelector('.markdown-preview-sizer')
        if (sizer) sizer.prepend(sentinel)
    }

    // ── Progress bar ──────────────────────────────────────────────
    // Lives directly in .markdown-preview-view — outside Obsidian's lazily-rendered
    // sections, so it's never removed. Hidden until sentinel scrolls out of view.
    const progressBar = activeDocument.createElement('div') as ProgressBar
    progressBar.className = 'qc-reading-progress qc-reading-progress--hidden'
    const progressFill = activeDocument.createElement('div')
    progressFill.className = 'qc-reading-progress-fill'
    progressBar.appendChild(progressFill)
    previewView.prepend(progressBar)

    const observer = new IntersectionObserver(([entry]) => {
        progressBar.classList.toggle('qc-reading-progress--hidden', entry.isIntersecting)
    }, { root: previewView })
    observer.observe(sentinel)

    const abortCtrl = new AbortController()
    previewView.addEventListener('scroll', () => {
        const { scrollTop, scrollHeight, clientHeight } = previewView
        const max = scrollHeight - clientHeight
        progressFill.setCssProps({'--qc-progress-pct': max > 0 ? `${(scrollTop / max) * 100}%` : '0%'})
    }, { signal: abortCtrl.signal })

    progressBar._cleanup = () => {
        abortCtrl.abort()
        observer.disconnect()
        sentinel.remove()
        if (anchor) (anchor as HTMLElement).removeClass('is-hidden')
    }
}
