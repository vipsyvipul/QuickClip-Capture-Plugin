import { ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian'
import QuickClipCapturePlugin from '../main'
import { loadIndex, getAllClips, deleteClip, updateContentType, updateClipTags } from '../clipsIndex'
import { ClipRef, Clip, ContentType } from '../types'

export const VIEW_CLIP_MANAGER = 'quickclip-manager'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const CLIP_TYPE_LABELS: Record<string, string> = {
    'highlight':     'Highlight',
    'full-page':     'Full page',
    'transcript':    'Transcript',
    'tweet':         'Tweet',
    'pdf-highlight': 'PDF',
    'image':         'Image',
}

type SortKey = 'saved_at' | 'clip_type' | 'content_type' | 'page_title' | 'domain'
type SortDir = 'asc' | 'desc'
type ColumnKey = 'clip_type' | 'content_type' | 'page_title' | 'domain' | 'saved_at' | 'tags' | 'path' | 'has_notes'

interface ColumnDef {
    key: ColumnKey
    label: string
    sortKey?: SortKey
}

const ALL_COLUMNS: ColumnDef[] = [
    { key: 'clip_type',    label: 'Format',       sortKey: 'clip_type' },
    { key: 'content_type', label: 'Content Type', sortKey: 'content_type' },
    { key: 'page_title',   label: 'Source Title',  sortKey: 'page_title' },
    { key: 'domain',       label: 'Domain',       sortKey: 'domain' },
    { key: 'saved_at',     label: 'Saved',        sortKey: 'saved_at' },
    { key: 'tags',         label: 'Tags' },
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
    private snippetRefreshTimer: ReturnType<typeof setTimeout> | null = null

    constructor(leaf: WorkspaceLeaf, plugin: QuickClipCapturePlugin) {
        super(leaf)
        this.plugin = plugin
    }

    getViewType(): string { return VIEW_CLIP_MANAGER }
    getDisplayText(): string { return 'QuickClip Capture' }
    getIcon(): string { return 'scissors' }

    async onOpen(): Promise<void> {
        this.registerEvent(
            this.app.vault.on('modify', async (file) => {
                if (!(file instanceof TFile)) return
                if (file.path === '.quickclip/clipsHistory.json') {
                    await this.refresh()
                    return
                }
                if (this.snippetRefreshTimer) clearTimeout(this.snippetRefreshTimer)
                this.snippetRefreshTimer = setTimeout(async () => {
                    this.snippetRefreshTimer = null
                    const affected = this.clips.filter(ref => ref.clip.path === file.path)
                    if (affected.length === 0) return
                    for (const ref of affected) {
                        this.snippetCache.delete(ref.clip.hash)
                        this.noteCache.delete(ref.clip.hash)
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
        const index = await loadIndex(this.app)
        this.clips = getAllClips(index)
        this.render()
        for (const ref of this.clips.filter(r => !this.noteCache.has(r.clip.hash))) {
            this.loadFileData(ref).then(() => this.updateClipCells(ref))
        }
    }

    private async loadFileData(ref: ClipRef): Promise<void> {
        if (!ref.clip.path) {
            this.noteCache.set(ref.clip.hash, false)
            return
        }
        const file = this.app.vault.getAbstractFileByPath(ref.clip.path)
        if (!(file instanceof TFile)) {
            this.noteCache.set(ref.clip.hash, false)
            return
        }
        const content = await this.app.vault.read(file)

        if (ref.clip.clip_type === 'full-page') {
            const bodyStart = content.indexOf('\n---\n', 4)
            const body = bodyStart !== -1 ? content.slice(bodyStart + 5) : content
            const bodyLines = body.split('\n')
            this.noteCache.set(ref.clip.hash, bodyLines.some(l => /^>\s*\[!note\]/i.test(l)))
            if (!this.snippetCache.has(ref.clip.hash)) {
                for (const line of bodyLines) {
                    const t = line.replace(/^#+\s*/, '').replace(/^>\s*/, '').trim()
                    if (t && !t.startsWith('[!') && !t.startsWith('|') && !t.startsWith('!')) {
                        this.snippetCache.set(ref.clip.hash, t); break
                    }
                }
            }
        } else {
            const date = new Date(ref.clip.savedAt)
            const capturedStr = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} \\| ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
            const lines = content.split('\n')
            const capturedIdx = lines.findIndex(l => l.includes(`| Captured | ${capturedStr} |`))
            if (capturedIdx === -1) {
                this.noteCache.set(ref.clip.hash, false)
                return
            }
            let quoteIdx = -1
            for (let i = capturedIdx - 1; i >= 0; i--) {
                if (lines[i].startsWith('> [!quote]')) { quoteIdx = i; break }
            }
            if (quoteIdx === -1) {
                this.noteCache.set(ref.clip.hash, false)
                return
            }
            // Note is present if there's a > [!note] block immediately before > [!quote]
            let hasNote = false
            for (let i = quoteIdx - 1; i >= 0; i--) {
                if (/^>\s*\[!note\]/i.test(lines[i])) { hasNote = true; break }
                if (lines[i] !== '' && !lines[i].startsWith('>')) break
            }
            this.noteCache.set(ref.clip.hash, hasNote)
            if (!this.snippetCache.has(ref.clip.hash) && !ref.clip.text) {
                const quoteLines: string[] = []
                for (let j = quoteIdx + 1; j < capturedIdx; j++) {
                    if (lines[j].startsWith('> ') && !lines[j].startsWith('> [!'))
                        quoteLines.push(lines[j].slice(2).trim())
                }
                const snippet = quoteLines.join(' ').trim()
                if (snippet) this.snippetCache.set(ref.clip.hash, snippet)
            }
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
        header.createEl('h2', { text: 'QuickClip Capture' })
        const right = header.createDiv('qc-manager-header-right')
        right.createDiv('qc-manager-count')
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
            emptyEl.appendText(' extension for Chrome browser and start saving.')
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

        this.filterClearBtn = bar.createEl('button', { cls: 'qc-filter-clear', text: '✕ Clear' })
        this.filterClearBtn.addEventListener('click', async () => {
            this.plugin.settings.filterFormat = ''
            this.plugin.settings.filterSource = ''
            this.plugin.settings.filterDate = ''
            await this.plugin.saveSettings()
            this.filterFormatEl.value = ''
            this.filterSourceEl.value = ''
            this.filterDateEl.value = ''
            ;[this.filterFormatEl, this.filterSourceEl, this.filterDateEl]
                .forEach(el => el.removeClass('qc-filter-select--active'))
            this.updateFilterClear()
            this.applyFilters()
        })

        for (const [el, key] of [
            [this.filterFormatEl, 'filterFormat'],
            [this.filterSourceEl, 'filterSource'],
            [this.filterDateEl,   'filterDate'],
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
        const { filterFormat, filterSource, filterDate } = this.plugin.settings
        this.filterClearBtn.style.display = filterFormat || filterSource || filterDate ? '' : 'none'
    }

    private getFiltered(): ClipRef[] {
        const { filterFormat, filterSource, filterDate } = this.plugin.settings
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
        return this.plugin.settings.visibleColumns.includes(col.key)
    }

    private renderTable(container: HTMLElement, clips: ClipRef[]): void {
        const sorted = this.sortClips(clips)
        const orderedCols = this.getOrderedColumns()

        const table = container.createEl('table', { cls: `qc-table qc-density-${this.plugin.settings.rowDensity}` })
        const thead = table.createEl('thead')
        const headerRow = thead.createEl('tr')

        headerRow.createEl('th', { text: 'Clip', cls: 'qc-th-snippet' })
        for (const col of orderedCols) {
            if (!this.isColVisible(col)) continue
            this.addDraggableHeader(headerRow, col)
        }
        headerRow.createEl('th', { text: 'Delete', cls: 'qc-th-delete' })

        const tbody = table.createEl('tbody')
        for (const ref of sorted) this.renderRow(tbody, ref, orderedCols)

        this.attachColumnDragTarget(table)
    }

    private addSortableHeader(row: HTMLElement, label: string, key: SortKey): HTMLElement {
        const th = row.createEl('th', { text: label, cls: 'qc-sortable' })
        if (key === this.sortKey) {
            th.addClass('qc-sorted')
            th.createSpan({ text: this.sortDir === 'asc' ? ' ↑' : ' ↓' })
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

    private sortClips(clips: ClipRef[]): ClipRef[] {
        return [...clips].sort((a, b) => {
            let va: string, vb: string
            switch (this.sortKey) {
                case 'saved_at':   va = a.clip.savedAt;    vb = b.clip.savedAt;    break
                case 'clip_type':    va = a.clip.clip_type;    vb = b.clip.clip_type;    break
                case 'content_type': va = a.content_type ?? ''; vb = b.content_type ?? ''; break
                case 'page_title':   va = a.pageTitle ?? '';    vb = b.pageTitle ?? '';    break
                case 'domain':     va = a.domain ?? '';    vb = b.domain ?? '';    break
                default:           va = a.clip.savedAt;    vb = b.clip.savedAt
            }
            return this.sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va)
        })
    }

    private renderRow(tbody: HTMLElement, ref: ClipRef, orderedCols: ColumnDef[]): void {
        const tr = tbody.createEl('tr', { cls: 'qc-row', attr: { 'data-hash': ref.clip.hash } })

        // Snippet — always first, linked to exact clip location
        const snippetTd = tr.createEl('td', { cls: 'qc-cell qc-cell--snippet' })
        const raw = ref.clip.text ?? this.snippetCache.get(ref.clip.hash) ?? CLIP_TYPE_LABELS[ref.clip.clip_type] ?? ref.clip.clip_type
        const len = this.plugin.settings.snippetLength
        const snippet = raw.length > len ? raw.slice(0, len) + '…' : raw
        const snippetLink = snippetTd.createEl('a', { cls: 'qc-snippet-link', text: snippet })
        snippetLink.title = ref.clip.text ?? raw
        snippetLink.addEventListener('click', (e) => { e.preventDefault(); this.openClip(ref) })

        for (const col of orderedCols) {
            if (!this.isColVisible(col)) continue
            const td = tr.createEl('td', { cls: 'qc-cell' })
            switch (col.key) {
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
                    for (const ct of ['article', 'video', 'tweet', 'pdf', 'github'] as ContentType[]) {
                        const opt = sel.createEl('option', { value: ct, text: ct })
                        if (ct === ref.content_type) opt.selected = true
                    }
                    sel.addEventListener('change', async () => {
                        ref.content_type = sel.value as ContentType
                        await updateContentType(this.app, ref.url, ref.content_type)
                    })
                    break
                }
                case 'page_title':
                    td.addClass('qc-cell--title')
                    td.textContent = ref.pageTitle ?? ''
                    td.title = ref.pageTitle ?? ''
                    break
                case 'domain':
                    if (ref.domain) td.createSpan({ cls: 'qc-domain-chip', text: ref.domain.replace(/^www\./, '') })
                    break
                case 'saved_at':
                    td.addClass('qc-cell--date')
                    td.textContent = formatDate(ref.clip.savedAt, this.plugin.settings.dateFormat)
                    break
                case 'tags':
                    this.renderEditableTags(td, ref)
                    break
                case 'has_notes':
                    td.textContent = this.noteCache.get(ref.clip.hash) ? 'Yes' : 'No'
                    td.addClass('qc-cell--has-notes')
                    break
                case 'path': {
                    td.addClass('qc-cell--path')
                    const fullPath = ref.clip.path ?? ''
                    td.textContent = this.plugin.settings.filePathDisplay === 'filename'
                        ? fullPath.split('/').pop() ?? fullPath
                        : fullPath
                    td.title = fullPath
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
        const tr = this.contentEl.querySelector(`tr[data-hash="${ref.clip.hash}"]`)
        if (!tr) return
        const raw = ref.clip.text ?? this.snippetCache.get(ref.clip.hash) ?? CLIP_TYPE_LABELS[ref.clip.clip_type] ?? ref.clip.clip_type
        const len = this.plugin.settings.snippetLength
        const snippetLink = tr.querySelector('.qc-snippet-link') as HTMLElement | null
        if (snippetLink) {
            snippetLink.textContent = raw.length > len ? raw.slice(0, len) + '…' : raw
            snippetLink.title = ref.clip.text ?? raw
        }
        const noteCell = tr.querySelector('.qc-cell--has-notes') as HTMLElement | null
        if (noteCell) noteCell.textContent = this.noteCache.get(ref.clip.hash) ? 'Yes' : 'No'
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
        const date = new Date(clip.savedAt)
        const capturedStr = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} \\| ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
        const capturedMarker = `| Captured | ${capturedStr} |`
        const lines = content.split('\n')
        const capturedLineIdx = lines.findIndex(l => l.includes(capturedMarker))
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
