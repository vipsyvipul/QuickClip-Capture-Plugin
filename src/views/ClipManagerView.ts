import { ItemView, WorkspaceLeaf, TFile, Notice } from 'obsidian'
import QuickClipCapturePlugin from '../main'
import { loadIndex, getAllClips, deleteClip } from '../clipsIndex'
import { ClipRef, Clip } from '../types'

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
type ColumnKey = 'clip_type' | 'content_type' | 'page_title' | 'domain' | 'saved_at' | 'tags' | 'path'

interface ColumnDef {
    key: ColumnKey
    label: string
    sortKey?: SortKey
}

const ALL_COLUMNS: ColumnDef[] = [
    { key: 'clip_type',    label: 'Format',       sortKey: 'clip_type' },
    { key: 'content_type', label: 'Content Type', sortKey: 'content_type' },
    { key: 'page_title',   label: 'Page',         sortKey: 'page_title' },
    { key: 'domain',       label: 'Domain',       sortKey: 'domain' },
    { key: 'saved_at',     label: 'Saved',        sortKey: 'saved_at' },
    { key: 'tags',         label: 'Tags' },
    { key: 'path',         label: 'File' },
]

export class ClipManagerView extends ItemView {
    private plugin: QuickClipCapturePlugin
    private clips: ClipRef[] = []
    private sortKey: SortKey = 'saved_at'
    private sortDir: SortDir = 'desc'
    private colPickerClose: (() => void) | null = null

    constructor(leaf: WorkspaceLeaf, plugin: QuickClipCapturePlugin) {
        super(leaf)
        this.plugin = plugin
    }

    getViewType(): string { return VIEW_CLIP_MANAGER }
    getDisplayText(): string { return 'QuickClip Capture' }
    getIcon(): string { return 'scissors' }

    async onOpen(): Promise<void> {
        await this.refresh()
    }

    async onClose(): Promise<void> {
        if (this.colPickerClose) {
            document.removeEventListener('click', this.colPickerClose)
            this.colPickerClose = null
        }
    }

    async refresh(): Promise<void> {
        const index = await loadIndex(this.app)
        this.clips = getAllClips(index)
        this.render()
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
        right.createDiv('qc-manager-count').setText(
            `${this.clips.length} clip${this.clips.length !== 1 ? 's' : ''}`
        )
        this.renderColumnPicker(right)

        if (this.clips.length === 0) {
            contentEl.createDiv('qc-manager-empty').setText(
                'No clips yet. Start saving from the browser extension.'
            )
            return
        }

        const wrap = contentEl.createDiv('qc-manager-table-wrap')
        this.renderTable(wrap)
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

    private renderTableOnly(): void {
        const wrap = this.contentEl.querySelector('.qc-manager-table-wrap') as HTMLElement | null
        if (!wrap) return
        wrap.empty()
        this.renderTable(wrap)
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

    private renderTable(container: HTMLElement): void {
        const sorted = this.getSorted()
        const orderedCols = this.getOrderedColumns()

        const table = container.createEl('table', { cls: 'qc-table' })
        const thead = table.createEl('thead')
        const headerRow = thead.createEl('tr')

        headerRow.createEl('th', { text: 'Clip', cls: 'qc-th-snippet' })
        for (const col of orderedCols) {
            if (!this.isColVisible(col)) continue
            this.addDraggableHeader(headerRow, col)
        }
        headerRow.createEl('th', { cls: 'qc-th-delete' })

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

    private getSorted(): ClipRef[] {
        return [...this.clips].sort((a, b) => {
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
        const tr = tbody.createEl('tr', { cls: 'qc-row' })

        // Snippet — always first, linked to exact clip location
        const snippetTd = tr.createEl('td', { cls: 'qc-cell qc-cell--snippet' })
        const raw = ref.clip.text ?? CLIP_TYPE_LABELS[ref.clip.clip_type] ?? ref.clip.clip_type
        const snippet = raw.length > 15 ? raw.slice(0, 15) + '…' : raw
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
                case 'content_type':
                    if (ref.content_type) td.createSpan({ cls: 'qc-domain-chip', text: ref.content_type })
                    break
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
                    td.textContent = formatDate(ref.clip.savedAt)
                    break
                case 'tags':
                    for (const tag of (ref.clip.tags ?? [])) {
                        td.createSpan({ cls: 'qc-tag-chip', text: tag })
                    }
                    break
                case 'path':
                    td.addClass('qc-cell--path')
                    td.textContent = ref.clip.path ?? ''
                    td.title = ref.clip.path ?? ''
                    break
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
            deleteBtn.disabled = true
            deleteBtn.setText('…')
            try {
                await deleteClip(this.app, ref.url, ref.clip.hash)
                tr.remove()
                this.clips = this.clips.filter(
                    c => !(c.url === ref.url && c.clip.hash === ref.clip.hash)
                )
                const countEl = this.contentEl.querySelector('.qc-manager-count')
                if (countEl) countEl.textContent = `${this.clips.length} clip${this.clips.length !== 1 ? 's' : ''}`
                new Notice('Clip deleted')
            } catch {
                new Notice('Failed to delete clip')
                deleteBtn.disabled = false
                deleteBtn.setText('✕')
            }
        })
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
            if (lines[i].startsWith('> [!quote] Clip')) return i
        }
        return capturedLineIdx
    }
}

function formatDate(iso: string): string {
    if (!iso) return ''
    try {
        return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: undefined })
    } catch {
        return ''
    }
}
