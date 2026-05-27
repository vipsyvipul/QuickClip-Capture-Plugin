import { App, MarkdownPostProcessorContext, TFile } from 'obsidian'

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

export function processFullPage(_app: App, _el: HTMLElement, _ctx: MarkdownPostProcessorContext): void {
    // header/progress injected via injectFullPageHeader on active-leaf-change
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
    if (anchor) (anchor as HTMLElement).style.display = 'none'
    let insertAfter: Element | null = anchor

    // ── Header pills ──────────────────────────────────────────────
    const { author, published, site, word_count } = meta.frontmatter ?? {}
    if (author || published || site || word_count) {
        const header = document.createElement('div')
        header.className = 'qc-fullpage-header'

        const addPill = (text: string) => {
            const pill = document.createElement('span')
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
    const sentinel = document.createElement('div')
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
    const progressBar = document.createElement('div') as ProgressBar
    progressBar.className = 'qc-reading-progress qc-reading-progress--hidden'
    const progressFill = document.createElement('div')
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
        progressFill.style.width = max > 0 ? `${(scrollTop / max) * 100}%` : '0%'
    }, { signal: abortCtrl.signal })

    progressBar._cleanup = () => {
        abortCtrl.abort()
        observer.disconnect()
        sentinel.remove()
        if (anchor) (anchor as HTMLElement).style.display = ''
    }
}
