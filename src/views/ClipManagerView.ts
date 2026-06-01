import { ItemView, WorkspaceLeaf, TFile, Notice, setIcon } from 'obsidian'
import QuickClipCapturePlugin from '../main'
import { loadIndex, saveIndex, getAllClips, deleteClip, updateContentType, updateClipTags, updateClipNote, invalidateIndexCache } from '../clipsIndex'
import { ClipRef, Clip, ContentType } from '../types'

export const VIEW_CLIP_MANAGER = 'quickclip-manager'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function clipKey(ref: ClipRef): string {
    return `${ref.clip.hash}|${ref.clip.savedAt}`
}

function formatTimestamp(seconds: number): string {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = Math.floor(seconds % 60)
    const mm = String(m).padStart(2, '0')
    const ss = String(s).padStart(2, '0')
    return h > 0 ? `▶ ${h}:${mm}:${ss}` : `▶ ${m}:${ss}`
}

function stripMarkdown(text: string): string {
    return text
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => alt || '')  // images → alt text
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')                     // links → label
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')                // bold
        .replace(/\*(.+?)\*|_(.+?)_/g, '$1$2')                      // italic
        .replace(/~~(.+?)~~/g, '$1')                                 // strikethrough
        .replace(/`([^`]+)`/g, '$1')                                 // inline code
        .trim()
}

const CLIP_TYPE_LABELS: Record<string, string> = {
    'highlight':     'Highlight',
    'full-page':     'Full page',
    'transcript':    'Transcript',
    'tweet':         'Tweet',
    'pdf-highlight': 'PDF',
    'image':         'Image',
    'video-clip':    'Video clip',
}

type SortKey = 'saved_at' | 'clip_type' | 'content_type' | 'page_title' | 'domain'
type SortDir = 'asc' | 'desc'
type ColumnKey = 'snippet' | 'clip_type' | 'content_type' | 'page_title' | 'domain' | 'saved_at' | 'tags' | 'note' | 'path' | 'has_notes'

interface ColumnDef {
    key: ColumnKey
    label: string
    sortKey?: SortKey
}

const ALL_COLUMNS: ColumnDef[] = [
    { key: 'snippet',      label: 'Clip' },
    { key: 'clip_type',    label: 'Format',       sortKey: 'clip_type' },
    { key: 'content_type', label: 'Content Type', sortKey: 'content_type' },
    { key: 'page_title',   label: 'Source Title',  sortKey: 'page_title' },
    { key: 'domain',       label: 'Domain',       sortKey: 'domain' },
    { key: 'saved_at',     label: 'Saved',        sortKey: 'saved_at' },
    { key: 'tags',         label: 'Tags' },
    { key: 'note',         label: 'Note' },
    { key: 'has_notes',    label: 'Has Note' },
    { key: 'path',         label: 'File Path' },
]

export class ClipManagerView extends ItemView {
    private plugin: QuickClipCapturePlugin
    private clips: ClipRef[] = []
    private sortKey: SortKey = 'saved_at'
    private sortDir: SortDir = 'desc'
    private colPickerClose: (() => void) | null = null
    private snippetCache = new Map<string, string>()
    private noteCache = new Map<string, boolean>()
    private noteTextCache = new Map<string, string>()
    private snippetRefreshTimer: ReturnType<typeof setTimeout> | null = null
    private resizeDragCleanup: (() => void) | null = null

    constructor(leaf: WorkspaceLeaf, plugin: QuickClipCapturePlugin) {
        super(leaf)
        this.plugin = plugin
    }

    getViewType(): string { return VIEW_CLIP_MANAGER }
    getDisplayText(): string { return 'QuickClip Capture Manager' }
    getIcon(): string { return 'quickclip-capture' }

    async onOpen(): Promise<void> {
        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (!(file instanceof TFile)) return
                if (file.path === '.quickclip/clipsHistory.json') {
                    invalidateIndexCache()
                    await this.refresh()
                    return
                }
                if (this.snippetRefreshTimer) clearTimeout(this.snippetRefreshTimer)
                this.snippetRefreshTimer = setTimeout(async () => {
                    this.snippetRefreshTimer = null
                    const affected = this.clips.filter(ref => ref.clip.path === file.path)
                    if (affected.length === 0) return
                    for (const ref of affected) {
                        this.snippetCache.delete(clipKey(ref))
                        this.noteCache.delete(clipKey(ref))
                        this.noteTextCache.delete(clipKey(ref))
                    }
                    for (const ref of affected) {
                        this.loadFileData(ref).then(() => this.updateClipCells(ref))
                    }
                }, 500)
            })
        )
        await this.refresh()
    }

    async onClose(): Promise<void> {
        this.resizeDragCleanup?.()
        this.resizeDragCleanup = null
        if (this.colPickerClose) {
            document.removeEventListener('click', this.colPickerClose)
            this.colPickerClose = null
        }
        if (this.snippetRefreshTimer) {
            clearTimeout(this.snippetRefreshTimer)
            this.snippetRefreshTimer = null
        }
    }

    async refresh(): Promise<void> {
        invalidateIndexCache()
        const index = await loadIndex(this.app)
        this.clips = getAllClips(index)
        this.render()
        const pending = this.clips.filter(r => !this.noteCache.has(clipKey(r)))
        await Promise.all(pending.map(ref => this.loadFileData(ref).then(() => this.updateClipCells(ref))))
        if (this.plugin.settings.filterNote) this.applyFilters()
    }

    private async loadFileData(ref: ClipRef): Promise<void> {
        if (!ref.clip.path) {
            this.noteCache.set(clipKey(ref), false)
            this.noteTextCache.set(clipKey(ref), '')
            return
        }
        const file = this.app.vault.getAbstractFileByPath(ref.clip.path)
        if (!(file instanceof TFile)) {
            this.noteCache.set(clipKey(ref), false)
            this.noteTextCache.set(clipKey(ref), '')
            return
        }
        const content = await this.app.vault.read(file)

        if (ref.clip.clip_type === 'full-page') {
            const bodyStart = content.indexOf('\n---\n', 4)
            const body = bodyStart !== -1 ? content.slice(bodyStart + 5) : content
            const bodyLines = body.split('\n')
            const noteStart = bodyLines.findIndex(l => /^>\s*\[!note\]/i.test(l))
            this.noteCache.set(clipKey(ref), noteStart !== -1)
            if (noteStart !== -1) {
                const noteLines: string[] = []
                for (let i = noteStart + 1; i < bodyLines.length; i++) {
                    if (!bodyLines[i].startsWith('>')) break
                    noteLines.push(bodyLines[i].replace(/^>\s*/, '').trim())
                }
                this.noteTextCache.set(clipKey(ref), noteLines.join('\n').replace(/<br\s*\/?>/gi, '\n'))
            } else {
                this.noteTextCache.set(clipKey(ref), '')
            }
            if (!this.snippetCache.has(clipKey(ref))) {
                for (const line of bodyLines) {
                    const t = stripMarkdown(line.replace(/^#+\s*/, ''))
                    if (t && !line.startsWith('#') && !line.startsWith('>') && !t.startsWith('|')) {
                        this.snippetCache.set(clipKey(ref), t); break
                    }
                }
            }
        } else if (ref.clip.clip_type === 'video-clip') {
            const date = new Date(ref.clip.savedAt)
            const dateStr = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} \\| ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
            const timeText = ref.clip.start_time != null ? formatTimestamp(ref.clip.start_time).replace('▶ ', '') : null
            const row = content.split('\n').find(l => {
                if (!l.includes(`| ${dateStr} |`)) return false
                if (timeText !== null) return l.includes(`[${timeText}]`)
                return true
            })
            if (!row) { this.noteCache.set(clipKey(ref), false); this.noteTextCache.set(clipKey(ref), ''); return }
            // cols[0]="| [timestamp](...)"  cols[1]=date  cols[2]=note  cols[3]=tags
            const note = row.split(' | ')[2]?.trim() ?? ''
            const timestamp = ref.clip.start_time != null ? formatTimestamp(ref.clip.start_time) : ''
            const noteDecoded = note.replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n')
            this.noteCache.set(clipKey(ref), noteDecoded.length > 0)
            this.noteTextCache.set(clipKey(ref), noteDecoded)
            if (!this.snippetCache.has(clipKey(ref)))
                this.snippetCache.set(clipKey(ref), timestamp)
        } else {
            const lines = content.split('\n')

            // New format: find by hash anchor
            if (ref.clip.hash) {
                const hashLineIdx = lines.findIndex(l => l.includes(`| QuickClip Hash | ${ref.clip.hash} |`))
                if (hashLineIdx !== -1) {
                    let parentIdx = -1
                    for (let i = hashLineIdx - 1; i >= 0; i--) {
                        if (/^> \[!qc_/.test(lines[i])) { parentIdx = i; break }
                    }
                    const detailsIdx = lines.findIndex((l, i) => i > (parentIdx !== -1 ? parentIdx : 0) && i < hashLineIdx && /^> > \[!qc_details\]/.test(l))
                    const noteLineIdx = lines.findIndex((l, i) => i > (parentIdx !== -1 ? parentIdx : 0) && i < (detailsIdx !== -1 ? detailsIdx : hashLineIdx) && /^> > \[!qc_note\]/.test(l))

                    this.noteCache.set(clipKey(ref), noteLineIdx !== -1)
                    if (noteLineIdx !== -1) {
                        const noteLines: string[] = []
                        for (let j = noteLineIdx + 1; j < lines.length; j++) {
                            if (!lines[j].startsWith('> > ')) break
                            noteLines.push(lines[j].slice(4).trim())
                        }
                        this.noteTextCache.set(clipKey(ref), noteLines.join('\n'))
                    } else {
                        this.noteTextCache.set(clipKey(ref), '')
                    }

                    if (!this.snippetCache.has(clipKey(ref)) && !ref.clip.text && parentIdx !== -1) {
                        const snippetLines: string[] = []
                        for (let j = parentIdx + 1; j < lines.length; j++) {
                            if (lines[j].startsWith('> > ') || lines[j] === '---') break
                            if (lines[j] === '>' || lines[j] === '') continue
                            if (lines[j].startsWith('> ')) {
                                const text = lines[j].slice(2).trim()
                                if (/^\[.*\]\(.*\)$/.test(text)) continue // skip source link
                                snippetLines.push(text)
                            }
                        }
                        const snippet = stripMarkdown(snippetLines.join(' '))
                        if (snippet) this.snippetCache.set(clipKey(ref), snippet)
                    }
                    this.syncTagsFromFile(ref, lines, detailsIdx !== -1 ? detailsIdx : hashLineIdx, hashLineIdx, true)
                    return
                }
            }

            // Old format: find by captured date anchor
            const date = new Date(ref.clip.savedAt)
            const capturedStr = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} \\| ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
            const capturedIdx = lines.findIndex(l => l.includes(`| Captured | ${capturedStr} |`))
            if (capturedIdx === -1) {
                this.noteCache.set(clipKey(ref), false); this.noteTextCache.set(clipKey(ref), ''); return
            }
            let quoteIdx = -1
            for (let i = capturedIdx - 1; i >= 0; i--) {
                if (lines[i].startsWith('> [!quote]')) { quoteIdx = i; break }
            }
            if (quoteIdx === -1) {
                this.noteCache.set(clipKey(ref), false); this.noteTextCache.set(clipKey(ref), ''); return
            }
            let noteBlockStart = -1
            let ni = quoteIdx - 1
            while (ni >= 0 && lines[ni] === '') ni--
            while (ni >= 0 && lines[ni].startsWith('>') && !/^>\s*\[!/.test(lines[ni])) ni--
            if (ni >= 0 && /^>\s*\[!note\]/i.test(lines[ni])) noteBlockStart = ni

            this.noteCache.set(clipKey(ref), noteBlockStart !== -1)
            if (noteBlockStart !== -1) {
                const noteLines: string[] = []
                for (let j = noteBlockStart + 1; j < quoteIdx; j++) {
                    if (!lines[j].startsWith('>') || /^>\s*\[!/.test(lines[j])) break
                    noteLines.push(lines[j].replace(/^>\s*/, '').trim())
                }
                this.noteTextCache.set(clipKey(ref), noteLines.join('\n').replace(/<br\s*\/?>/gi, '\n'))
            } else {
                this.noteTextCache.set(clipKey(ref), '')
            }
            if (!this.snippetCache.has(clipKey(ref)) && !ref.clip.text) {
                const quoteLines: string[] = []
                for (let j = quoteIdx + 1; j < capturedIdx; j++) {
                    if (lines[j].startsWith('> ') && !lines[j].startsWith('> [!'))
                        quoteLines.push(lines[j].slice(2).trim())
                }
                const snippet = stripMarkdown(quoteLines.join(' '))
                if (snippet) this.snippetCache.set(clipKey(ref), snippet)
            }
            this.syncTagsFromFile(ref, lines, capturedIdx - 5, capturedIdx + 5, false)
        }
    }

    private render(): void {
        if (this.colPickerClose) {
            document.removeEventListener('click', this.colPickerClose)
            this.colPickerClose = null
        }

        const { contentEl } = this
        contentEl.empty()
        contentEl.addClass('qc-manager')

        const header = contentEl.createDiv('qc-manager-header')
        header.createEl('h2', { text: 'QuickClip Capture Manager' })
        const right = header.createDiv('qc-manager-header-right')
        right.createDiv('qc-manager-count')
        const refreshBtn = right.createEl('button', { cls: 'qc-refresh-btn', attr: { title: 'Refresh', 'aria-label': 'Refresh' } })
        setIcon(refreshBtn, 'refresh-cw')
        refreshBtn.addEventListener('click', () => this.refresh())
        this.renderColumnPicker(right)

        if (this.clips.length === 0) {
            this.updateCount()
            const emptyEl = contentEl.createDiv('qc-manager-empty')
            emptyEl.appendText('Nothing clipped yet. Install ')
            emptyEl.createEl('a', {
                text: 'QuickClip Capture',
                href: 'https://chromewebstore.google.com/detail/quickclip/edabdpgppnhbogfpdghjekdalmipflel',
                cls: 'external-link',
            })
            emptyEl.appendText(' extension for Chrome browser and start clipping.')
            return
        }

        this.renderFilterBar(contentEl)
        this.updateCount()

        const wrap = contentEl.createDiv('qc-manager-table-wrap')
        const filtered = this.getFiltered()
        if (filtered.length === 0) {
            wrap.createDiv('qc-manager-empty').setText('No clips match the current filters.')
        } else {
            this.renderTable(wrap, filtered)
        }
    }

    private filterFormatEl!: HTMLSelectElement
    private filterSourceEl!: HTMLSelectElement
    private filterDateEl!: HTMLSelectElement
    private filterNoteEl!: HTMLSelectElement
    private filterClearBtn!: HTMLButtonElement

    private renderFilterBar(container: HTMLElement): void {
        const bar = container.createDiv('qc-filter-bar')
        bar.createSpan({ cls: 'qc-filter-heading', text: 'Filters:' })

        const formats = [...new Set(this.clips.map(r => r.clip.clip_type).filter(Boolean))].sort()
        this.filterFormatEl = this.createFilterSelect(bar, 'Format', [
            { value: '', label: 'All formats' },
            ...formats.map(f => ({ value: f, label: CLIP_TYPE_LABELS[f] ?? f })),
        ], this.plugin.settings.filterFormat)

        const domains = [...new Set(this.clips.map(r => r.domain ?? '').filter(Boolean))].sort()
        this.filterSourceEl = this.createFilterSelect(bar, 'Domain', [
            { value: '', label: 'All domains' },
            ...domains.map(d => ({ value: d, label: d.replace(/^www\./, '') })),
        ], this.plugin.settings.filterSource)

        this.filterDateEl = this.createFilterSelect(bar, 'Date', [
            { value: '',      label: 'All time' },
            { value: 'today', label: 'Today' },
            { value: 'week',  label: 'Last 7 days' },
            { value: 'month', label: 'Last 30 days' },
        ], this.plugin.settings.filterDate)

        this.filterNoteEl = this.createFilterSelect(bar, 'Has Note', [
            { value: '',    label: 'All' },
            { value: 'yes', label: 'Yes' },
            { value: 'no',  label: 'No' },
        ], this.plugin.settings.filterNote)

        this.filterClearBtn = bar.createEl('button', { cls: 'qc-filter-clear', text: '✕ Clear' })
        this.filterClearBtn.addEventListener('click', async () => {
            this.plugin.settings.filterFormat = ''
            this.plugin.settings.filterSource = ''
            this.plugin.settings.filterDate = ''
            this.plugin.settings.filterNote = ''
            await this.plugin.saveSettings()
            this.filterFormatEl.value = ''
            this.filterSourceEl.value = ''
            this.filterDateEl.value = ''
            this.filterNoteEl.value = ''
            ;[this.filterFormatEl, this.filterSourceEl, this.filterDateEl, this.filterNoteEl]
                .forEach(el => el.removeClass('qc-filter-select--active'))
            this.updateFilterClear()
            this.applyFilters()
        })

        for (const [el, key] of [
            [this.filterFormatEl, 'filterFormat'],
            [this.filterSourceEl, 'filterSource'],
            [this.filterDateEl,   'filterDate'],
            [this.filterNoteEl,   'filterNote'],
        ] as [HTMLSelectElement, string][]) {
            el.addEventListener('change', async () => {
                (this.plugin.settings as unknown as Record<string, string>)[key] = el.value
                await this.plugin.saveSettings()
                el.toggleClass('qc-filter-select--active', !!el.value)
                this.updateFilterClear()
                this.applyFilters()
            })
        }

        this.updateFilterClear()
    }

    private createFilterSelect(
        container: HTMLElement,
        label: string,
        options: { value: string; label: string }[],
        current: string
    ): HTMLSelectElement {
        const wrap = container.createDiv('qc-filter-group')
        wrap.createSpan({ cls: 'qc-filter-label', text: label })
        const sel = wrap.createEl('select', { cls: 'qc-filter-select' })
        for (const o of options) sel.createEl('option', { value: o.value, text: o.label })
        sel.value = current
        if (current) sel.addClass('qc-filter-select--active')
        return sel
    }

    private updateFilterClear(): void {
        if (!this.filterClearBtn) return
        const { filterFormat, filterSource, filterDate, filterNote } = this.plugin.settings
        this.filterClearBtn.style.display = filterFormat || filterSource || filterDate || filterNote ? '' : 'none'
    }

    private getFiltered(): ClipRef[] {
        const { filterFormat, filterSource, filterDate, filterNote } = this.plugin.settings
        const now = Date.now()
        const DAY = 86400000
        return this.clips.filter(ref => {
            if (filterFormat && ref.clip.clip_type !== filterFormat) return false
            if (filterSource && ref.domain !== filterSource) return false
            if (filterDate) {
                const age = now - new Date(ref.clip.savedAt).getTime()
                if (filterDate === 'today' && age > DAY) return false
                if (filterDate === 'week'  && age > 7 * DAY) return false
                if (filterDate === 'month' && age > 30 * DAY) return false
            }
            if (filterNote === 'yes' && this.noteCache.get(clipKey(ref)) !== true) return false
            if (filterNote === 'no'  && this.noteCache.get(clipKey(ref)) === true) return false
            return true
        })
    }

    private applyFilters(): void {
        const wrap = this.contentEl.querySelector('.qc-manager-table-wrap') as HTMLElement | null
        if (!wrap) return
        wrap.empty()
        const filtered = this.getFiltered()
        if (filtered.length === 0) {
            wrap.createDiv('qc-manager-empty').setText('No clips match the current filters.')
        } else {
            this.renderTable(wrap, filtered)
        }
        this.updateCount()
    }

    private updateCount(): void {
        const countEl = this.contentEl.querySelector('.qc-manager-count')
        if (!countEl) return
        const total = this.clips.length
        const filtered = this.getFiltered().length
        countEl.textContent = filtered === total
            ? `${total} clip${total !== 1 ? 's' : ''}`
            : `${filtered} of ${total} clip${total !== 1 ? 's' : ''}`
    }

    private renderColumnPicker(container: HTMLElement): void {
        const wrapper = container.createDiv('qc-col-picker-wrapper')
        const btn = wrapper.createEl('button', { cls: 'qc-col-picker-btn', text: 'Columns ▾' })
        const panel = wrapper.createDiv('qc-col-picker-panel')
        panel.style.display = 'none'

        for (const col of ALL_COLUMNS) {
            if (col.key === 'snippet') continue
            const item = panel.createEl('label', { cls: 'qc-col-picker-item' })
            const cb = item.createEl('input', { type: 'checkbox' })
            cb.checked = this.plugin.settings.visibleColumns.includes(col.key)
            item.appendText(' ' + col.label)
            cb.addEventListener('change', async () => {
                if (cb.checked) {
                    if (!this.plugin.settings.visibleColumns.includes(col.key))
                        this.plugin.settings.visibleColumns.push(col.key)
                } else {
                    this.plugin.settings.visibleColumns = this.plugin.settings.visibleColumns.filter(k => k !== col.key)
                }
                await this.plugin.saveSettings()
                this.renderTableOnly()
            })
        }

        btn.addEventListener('click', (e) => {
            e.stopPropagation()
            const isOpen = panel.style.display !== 'none'
            panel.style.display = isOpen ? 'none' : ''
            if (isOpen) {
                if (this.colPickerClose) {
                    document.removeEventListener('click', this.colPickerClose)
                    this.colPickerClose = null
                }
            } else {
                this.colPickerClose = () => {
                    panel.style.display = 'none'
                    document.removeEventListener('click', this.colPickerClose!)
                    this.colPickerClose = null
                }
                document.addEventListener('click', this.colPickerClose)
            }
        })
        panel.addEventListener('click', (e) => e.stopPropagation())
    }

    private rawSnippet(ref: ClipRef): string {
        const startTimeStr = ref.clip.start_time != null ? formatTimestamp(ref.clip.start_time) : ''
        return stripMarkdown(ref.clip.text ?? this.snippetCache.get(clipKey(ref)) ?? '')
            || startTimeStr
            || ref.pageTitle
            || (CLIP_TYPE_LABELS[ref.clip.clip_type] ?? ref.clip.clip_type)
    }

    public rerenderTable(): void { this.renderTableOnly() }

    private renderTableOnly(): void {
        const wrap = this.contentEl.querySelector('.qc-manager-table-wrap') as HTMLElement | null
        if (!wrap) return
        wrap.empty()
        const filtered = this.getFiltered()
        if (filtered.length === 0) {
            wrap.createDiv('qc-manager-empty').setText('No clips match the current filters.')
        } else {
            this.renderTable(wrap, filtered)
        }
    }

    private getOrderedColumns(): ColumnDef[] {
        const order = this.plugin.settings.columnOrder
        if (!order.length) return ALL_COLUMNS
        return [...ALL_COLUMNS].sort((a, b) => {
            const ai = order.indexOf(a.key)
            const bi = order.indexOf(b.key)
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
        })
    }

    private isColVisible(col: ColumnDef): boolean {
        if (col.key === 'snippet') return true
        return this.plugin.settings.visibleColumns.includes(col.key)
    }

    private renderTable(container: HTMLElement, clips: ClipRef[]): void {
        const sorted = this.sortClips(clips)
        const orderedCols = this.getOrderedColumns()

        const table = container.createEl('table', { cls: `qc-table qc-density-${this.plugin.settings.rowDensity}` })
        const thead = table.createEl('thead')
        const headerRow = thead.createEl('tr')

        for (const col of orderedCols) {
            if (!this.isColVisible(col)) continue
            this.addDraggableHeader(headerRow, col)
        }
        headerRow.createEl('th', { text: 'Delete', cls: 'qc-th-delete' })

        const tbody = table.createEl('tbody')
        for (const ref of sorted) this.renderRow(tbody, ref, orderedCols)

        this.attachColumnDragTarget(table)
        this.attachResizeHandles(table)
    }

    private addSortableHeader(row: HTMLElement, label: string, key: SortKey): HTMLElement {
        const th = row.createEl('th', { text: label, cls: 'qc-sortable' })
        if (key === this.sortKey) {
            th.addClass('qc-sorted')
            th.dataset.sortDir = this.sortDir
        }
        th.addEventListener('click', () => {
            if (this.sortKey === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc'
            else { this.sortKey = key; this.sortDir = 'desc' }
            this.renderTableOnly()
        })
        return th
    }

    private addDraggableHeader(row: HTMLElement, col: ColumnDef): HTMLElement {
        const th = col.sortKey
            ? this.addSortableHeader(row, col.label, col.sortKey)
            : row.createEl('th', { text: col.label })
        th.draggable = true
        th.addClass('qc-col-draggable')
        th.dataset.colKey = col.key

        th.addEventListener('dragstart', (e) => {
            e.dataTransfer!.setData('text/plain', col.key)
            e.dataTransfer!.effectAllowed = 'move'
            th.addClass('qc-col-dragging')
        })
        th.addEventListener('dragend', () => {
            th.removeClass('qc-col-dragging')
        })
        return th
    }

    private attachColumnDragTarget(table: HTMLElement): void {
        const clearHighlights = () => {
            table.querySelectorAll('.qc-col-drag-before, .qc-col-drag-after').forEach(el =>
                el.classList.remove('qc-col-drag-before', 'qc-col-drag-after')
            )
        }

        const applyHighlight = (colIdx: number, dir: 'before' | 'after') => {
            clearHighlights()
            table.querySelectorAll(
                `thead tr th:nth-child(${colIdx + 1}), tbody tr td:nth-child(${colIdx + 1})`
            ).forEach(el => el.classList.add(`qc-col-drag-${dir}`))
        }

        const getThAt = (colIdx: number): HTMLElement | null =>
            table.querySelector(`thead tr th:nth-child(${colIdx + 1})`)

        table.addEventListener('dragover', (e) => {
            const cell = (e.target as HTMLElement).closest('th, td') as HTMLTableCellElement | null
            if (!cell) return
            const th = getThAt(cell.cellIndex)
            if (!th?.dataset.colKey) return
            e.preventDefault()
            const mid = cell.getBoundingClientRect().left + cell.offsetWidth / 2
            applyHighlight(cell.cellIndex, e.clientX < mid ? 'before' : 'after')
        })

        table.addEventListener('dragleave', (e) => {
            if (!table.contains(e.relatedTarget as Node)) clearHighlights()
        })

        table.addEventListener('drop', async (e) => {
            const cell = (e.target as HTMLElement).closest('th, td') as HTMLTableCellElement | null
            if (!cell) return
            const th = getThAt(cell.cellIndex)
            if (!th?.dataset.colKey) return
            e.preventDefault()
            const insertBefore = e.clientX < cell.getBoundingClientRect().left + cell.offsetWidth / 2
            clearHighlights()
            const fromKey = e.dataTransfer!.getData('text/plain') as ColumnKey
            const toKey = th.dataset.colKey as ColumnKey
            if (!fromKey || fromKey === toKey) return
            const keys = this.getOrderedColumns().map(c => c.key)
            const fromIdx = keys.indexOf(fromKey)
            if (fromIdx === -1) return
            keys.splice(fromIdx, 1)
            const toIdx = keys.indexOf(toKey)
            if (toIdx === -1) return
            keys.splice(insertBefore ? toIdx : toIdx + 1, 0, fromKey)
            this.plugin.settings.columnOrder = keys
            await this.plugin.saveSettings()
            this.renderTableOnly()
        })
    }

    private attachResizeHandles(table: HTMLElement): void {
        const widths = this.plugin.settings.columnWidths ?? {}
        const ths = Array.from(table.querySelectorAll('thead tr th')) as HTMLTableCellElement[]

        for (const th of ths) {
            if (th.classList.contains('qc-th-delete')) continue
            const key = th.dataset.colKey
            if (!key) continue

            if (widths[key]) th.style.minWidth = widths[key] + 'px'

            const handle = th.createDiv('qc-resize-handle')
            handle.draggable = false

            handle.addEventListener('mousedown', (e) => {
                e.preventDefault()
                e.stopPropagation()
                const startX = e.clientX
                const startW = th.offsetWidth
                document.body.style.userSelect = 'none'

                const onMove = (ev: MouseEvent) => {
                    const newW = Math.max(60, startW + (ev.clientX - startX))
                    th.style.minWidth = newW + 'px'
                }

                const cleanup = () => {
                    document.removeEventListener('mousemove', onMove)
                    document.removeEventListener('mouseup', onUp)
                    document.body.style.userSelect = ''
                    this.resizeDragCleanup = null
                }

                const onUp = async () => {
                    cleanup()
                    if (document.contains(th)) {
                        this.plugin.settings.columnWidths[key] = th.offsetWidth
                        await this.plugin.saveSettings()
                    }
                }

                this.resizeDragCleanup = cleanup
                document.addEventListener('mousemove', onMove)
                document.addEventListener('mouseup', onUp)
            })
        }
    }

    private sortClips(clips: ClipRef[]): ClipRef[] {
        return [...clips].sort((a, b) => {
            let va: string, vb: string
            switch (this.sortKey) {
                case 'saved_at':   va = a.clip.savedAt ?? '';    vb = b.clip.savedAt ?? '';    break
                case 'clip_type':    va = a.clip.clip_type ?? '';    vb = b.clip.clip_type ?? '';    break
                case 'content_type': va = a.content_type ?? ''; vb = b.content_type ?? ''; break
                case 'page_title':   va = a.pageTitle ?? '';    vb = b.pageTitle ?? '';    break
                case 'domain':     va = a.domain ?? '';    vb = b.domain ?? '';    break
                default:           va = a.clip.savedAt;    vb = b.clip.savedAt
            }
            return this.sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
        })
    }

    private renderRow(tbody: HTMLElement, ref: ClipRef, orderedCols: ColumnDef[]): void {
        const tr = tbody.createEl('tr', { cls: 'qc-row', attr: { 'data-clip-key': clipKey(ref) } })

        for (const col of orderedCols) {
            if (!this.isColVisible(col)) continue
            const td = tr.createEl('td', { cls: 'qc-cell' })
            switch (col.key) {
                case 'snippet': {
                    td.addClass('qc-cell--snippet')
                    const raw = this.rawSnippet(ref)
                    const len = this.plugin.settings.snippetLength
                    const snippet = raw.length > len ? raw.slice(0, len) + '…' : raw
                    const snippetLink = td.createEl('a', { cls: 'qc-snippet-link', text: snippet })
                    snippetLink.title = ref.clip.text ?? raw
                    snippetLink.addEventListener('click', (e) => { e.preventDefault(); this.openClip(ref) })
                    break
                }
                case 'clip_type': {
                    const badge = td.createSpan({
                        cls: `qc-clip-badge qc-badge-${ref.clip.clip_type}`,
                        text: CLIP_TYPE_LABELS[ref.clip.clip_type] ?? ref.clip.clip_type,
                    })
                    badge.setAttribute('aria-label', ref.clip.clip_type)
                    break
                }
                case 'content_type': {
                    const sel = td.createEl('select', { cls: 'qc-content-type-select' })
                    sel.dataset.ct = ref.content_type ?? ''
                    for (const ct of ['article', 'video', 'tweet', 'pdf', 'github'] as ContentType[]) {
                        const opt = sel.createEl('option', { value: ct, text: ct })
                        if (ct === ref.content_type) opt.selected = true
                    }
                    sel.addEventListener('change', async () => {
                        ref.content_type = sel.value as ContentType
                        sel.dataset.ct = sel.value
                        await updateContentType(this.app, ref.url, ref.content_type)
                    })
                    break
                }
                case 'page_title': {
                    td.addClass('qc-cell--title')
                    const titleLink = td.createEl('a', { cls: 'qc-cell-link', text: ref.pageTitle ?? '' })
                    titleLink.title = ref.pageTitle ?? ''
                    titleLink.addEventListener('click', (e) => { e.preventDefault(); this.openClip(ref) })
                    break
                }
                case 'domain':
                    if (ref.domain) td.createSpan({ cls: 'qc-domain-chip', text: ref.domain.replace(/^www\./, '') })
                    break
                case 'saved_at':
                    td.addClass('qc-cell--date')
                    td.textContent = formatDate(ref.clip.savedAt, this.plugin.settings.dateFormat)
                    break
                case 'tags':
                    td.addClass('qc-cell--tags')
                    this.renderEditableTags(td, ref)
                    break
                case 'note':
                    this.renderEditableNote(td, ref)
                    break
                case 'has_notes':
                    td.textContent = this.noteCache.get(clipKey(ref)) ? 'Yes' : 'No'
                    td.addClass('qc-cell--has-notes')
                    break
                case 'path': {
                    td.addClass('qc-cell--path')
                    const fullPath = ref.clip.path ?? ''
                    const displayPath = this.plugin.settings.filePathDisplay === 'filename'
                        ? fullPath.split('/').pop() ?? fullPath
                        : fullPath
                    const pathLink = td.createEl('a', { cls: 'qc-cell-link', text: displayPath })
                    pathLink.title = fullPath
                    pathLink.addEventListener('click', (e) => { e.preventDefault(); this.openClip(ref) })
                    break
                }
            }
        }

        // Delete
        const deleteTd = tr.createEl('td', { cls: 'qc-cell qc-cell--delete' })
        const deleteBtn = deleteTd.createEl('button', {
            cls: 'qc-delete-btn',
            text: '✕',
            attr: { 'aria-label': 'Delete clip' },
        })
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation()
            if (this.plugin.settings.confirmDelete) {
                if (!window.confirm('Delete this clip? This cannot be undone.')) return
            }
            deleteBtn.disabled = true
            deleteBtn.setText('…')
            try {
                await deleteClip(this.app, ref.url, ref.clip.hash)
                tr.remove()
                this.clips = this.clips.filter(
                    c => !(c.url === ref.url && c.clip.hash === ref.clip.hash)
                )
                this.updateCount()
                new Notice('Clip deleted')
            } catch {
                new Notice('Failed to delete clip')
                deleteBtn.disabled = false
                deleteBtn.setText('✕')
            }
        })
    }

    private updateClipCells(ref: ClipRef): void {
        const tr = this.contentEl.querySelector(`tr[data-clip-key="${CSS.escape(clipKey(ref))}"]`)
        if (!tr) return
        const raw = this.rawSnippet(ref)
        const len = this.plugin.settings.snippetLength
        const snippetLink = tr.querySelector('.qc-snippet-link') as HTMLElement | null
        if (snippetLink) {
            snippetLink.textContent = raw.length > len ? raw.slice(0, len) + '…' : raw
            snippetLink.title = ref.clip.text ?? raw
        }
        const noteCell = tr.querySelector('.qc-cell--has-notes') as HTMLElement | null
        if (noteCell) noteCell.textContent = this.noteCache.get(clipKey(ref)) ? 'Yes' : 'No'
        const noteInput = tr.querySelector('.qc-note-input') as HTMLTextAreaElement | null
        if (noteInput && document.activeElement !== noteInput) {
            const noteText = this.noteTextCache.get(clipKey(ref)) ?? ''
            noteInput.value = noteText
            noteInput.dataset.saved = noteText
            noteInput.dispatchEvent(new Event('input'))
        }
        const tagsCell = tr.querySelector<HTMLElement>('.qc-cell--tags')
        if (tagsCell) { tagsCell.empty(); this.renderEditableTags(tagsCell, ref) }
    }

    private syncTagsFromFile(ref: ClipRef, lines: string[], from: number, to: number, newFormat: boolean): void {
        const pattern = newFormat ? /^> > \| Tags \| (.*?) \|/ : /^\| Tags \| (.*?) \|/
        const tagsLine = lines.slice(Math.max(0, from), to + 1).find(l => pattern.test(l))
        if (!tagsLine) return
        const m = tagsLine.match(pattern)
        if (!m) return
        const fileTags = m[1].trim().split(/\s+/).filter(Boolean).map(t => t.replace(/^#/, ''))
        const curr = ref.clip.tags ?? []
        if (fileTags.length === curr.length && fileTags.every(t => curr.includes(t))) return
        ref.clip.tags = fileTags
        loadIndex(this.app).then(idx => {
            const clip = idx[ref.url]?.clips.find(c => c.hash === ref.clip.hash)
            if (clip) { clip.tags = fileTags; saveIndex(this.app, idx) }
        })
    }

    private renderEditableNote(td: HTMLElement, ref: ClipRef): void {
        const noteText = this.noteTextCache.get(clipKey(ref)) ?? ''
        const ta = td.createEl('textarea', {
            cls: 'qc-note-input',
            attr: { rows: '1', placeholder: 'Add note...', 'aria-label': 'Note', 'data-saved': noteText },
        }) as HTMLTextAreaElement
        ta.value = noteText

        const resize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px' }
        resize()
        ta.addEventListener('input', resize)

        ta.addEventListener('blur', async () => {
            const newNote = ta.value.trim()
            const saved = ta.dataset.saved ?? ''
            if (newNote === saved) return
            ta.dataset.saved = newNote
            this.noteTextCache.set(clipKey(ref), newNote)
            this.noteCache.set(clipKey(ref), newNote.length > 0)
            await updateClipNote(this.app, ref.url, ref.clip.hash, newNote)
        })
        ta.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur() }
            // Shift+Enter: default behavior inserts newline
        })
    }

    private renderEditableTags(td: HTMLElement, ref: ClipRef): void {
        const allTags = [...new Set(this.clips.flatMap(r => r.clip.tags ?? []))].sort()
        const listId = `qc-tags-${ref.clip.hash}`

        const rebuild = () => {
            td.empty()
            for (const tag of (ref.clip.tags ?? [])) {
                const chip = td.createSpan({ cls: 'qc-tag-chip qc-tag-editable' })
                chip.createSpan({ text: tag })
                const btn = chip.createEl('button', { cls: 'qc-tag-remove', text: '×' })
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation()
                    ref.clip.tags = (ref.clip.tags ?? []).filter(t => t !== tag)
                    await updateClipTags(this.app, ref.url, ref.clip.hash, ref.clip.tags)
                    rebuild()
                })
            }
            const dl = td.createEl('datalist', { attr: { id: listId } })
            for (const t of allTags) dl.createEl('option', { value: t })
            const input = td.createEl('input', {
                cls: 'qc-tag-input',
                attr: { list: listId, placeholder: 'Add...', 'aria-label': 'Add tag' },
            })
            input.addEventListener('keydown', async (e: KeyboardEvent) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const val = input.value.trim()
                if (!val || (ref.clip.tags ?? []).includes(val)) { input.value = ''; return }
                ref.clip.tags = [...(ref.clip.tags ?? []), val]
                await updateClipTags(this.app, ref.url, ref.clip.hash, ref.clip.tags)
                input.value = ''
                rebuild()
            })
            input.addEventListener('change', async () => {
                const val = input.value.trim()
                if (!val || (ref.clip.tags ?? []).includes(val)) { input.value = ''; return }
                ref.clip.tags = [...(ref.clip.tags ?? []), val]
                await updateClipTags(this.app, ref.url, ref.clip.hash, ref.clip.tags)
                input.value = ''
                rebuild()
            })
        }
        rebuild()
    }

    private async openClip(ref: ClipRef): Promise<void> {
        if (!ref.clip.path) return
        const file = this.app.vault.getAbstractFileByPath(ref.clip.path)
        if (!(file instanceof TFile)) return

        let line = 0
        if (ref.clip.clip_type === 'highlight' || ref.clip.clip_type === 'pdf-highlight') {
            line = await this.findHighlightLine(ref.clip)
        }

        await this.app.workspace.getLeaf(false).openFile(file, {
            state: { mode: 'preview' },
            eState: line > 0 ? { line } : undefined,
        })
    }

    private async findHighlightLine(clip: Clip): Promise<number> {
        const file = this.app.vault.getAbstractFileByPath(clip.path)
        if (!(file instanceof TFile)) return 0
        const content = await this.app.vault.read(file)
        const lines = content.split('\n')

        // New format: find by hash, walk back to parent callout opener
        if (clip.hash) {
            const hashLineIdx = lines.findIndex(l => l.includes(`| QuickClip Hash | ${clip.hash} |`))
            if (hashLineIdx !== -1) {
                for (let i = hashLineIdx - 1; i >= 0; i--) {
                    if (/^> \[!qc_/.test(lines[i])) return i
                }
            }
        }

        // Old format: find by captured date, walk back to > [!quote]
        const date = new Date(clip.savedAt)
        const capturedStr = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} \\| ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
        const capturedLineIdx = lines.findIndex(l => l.includes(`| Captured | ${capturedStr} |`))
        if (capturedLineIdx === -1) return 0
        for (let i = capturedLineIdx - 1; i >= 0; i--) {
            if (lines[i].startsWith('> [!quote]')) return i
        }
        return capturedLineIdx
    }
}

function formatDate(iso: string, format: 'absolute' | 'relative' | 'full' = 'absolute'): string {
    if (!iso) return ''
    try {
        const date = new Date(iso)
        if (format === 'full')
            return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
        if (format === 'relative') {
            const diff = Date.now() - date.getTime()
            const mins  = Math.floor(diff / 60_000)
            const hours = Math.floor(diff / 3_600_000)
            const days  = Math.floor(diff / 86_400_000)
            if (mins  < 60)  return `${mins}m ago`
            if (hours < 24)  return `${hours}h ago`
            if (days  < 7)   return `${days}d ago`
            if (days  < 30)  return `${Math.floor(days / 7)}w ago`
            if (days  < 365) return `${Math.floor(days / 30)}mo ago`
            return `${Math.floor(days / 365)}y ago`
        }
        return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: undefined })
    } catch {
        return ''
    }
}
