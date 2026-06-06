import { addIcon, MarkdownView, Plugin, TFile } from 'obsidian'
import { processHighlight, scanAndTransform } from './renderers/highlight'
import { processFullPage, injectFullPageHeader } from './renderers/fullPage'
import { injectVideoClipView } from './renderers/videoClip'
import { ClipManagerView, VIEW_CLIP_MANAGER } from './views/ClipManagerView'
import { QuickClipSettingTab } from './settings'

export interface PluginSettings {
    visibleColumns: string[]
    columnOrder: string[]
    filterFormat: string
    filterSource: string
    filterDate: string
    filterNote: string
    confirmDelete: boolean
    rowDensity: 'compact' | 'comfortable' | 'spacious'
    snippetLength: number
    dateFormat: 'absolute' | 'relative' | 'full'
    filePathDisplay: 'full' | 'filename'
    autoOpenOnStartup: boolean
    columnWidths: Record<string, number>
    calloutColors: Record<string, string>
    lastMigrationReport?: {
        migrated: number
        skipped: number
        timestamp: string
        results: Array<{ filePath: string; preview: string; status: string; reason: string }>
    }
}

export const DEFAULT_CALLOUT_COLORS: Record<string, string> = {
    qc_highlight:     '#E8A838',
    qc_tweet:         '#1D9BF0',
    qc_pdf_highlight: '#E05252',
    qc_image:         '#9B59B6',
    qc_note:          '#6B7280',
    qc_details:       '#9CA3AF',
}

function hexToRgb(hex: string): [number, number, number] {
    const n = parseInt(hex.replace('#', ''), 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const DEFAULT_SETTINGS: PluginSettings = {
    visibleColumns: ['page_title', 'content_type', 'note', 'tags'],
    columnOrder: ['page_title', 'snippet', 'content_type', 'note', 'tags'],
    filterFormat: '',
    filterSource: '',
    filterDate: '',
    filterNote: '',
    confirmDelete: false,
    rowDensity: 'comfortable',
    snippetLength: 20,
    dateFormat: 'absolute',
    filePathDisplay: 'full',
    autoOpenOnStartup: false,
    columnWidths: {},
    calloutColors: { ...DEFAULT_CALLOUT_COLORS },
}

const QC_ICON_ID = 'quickclip-capture'
const QC_ICON_SVG =
    '<rect x="6" y="32" width="88" height="58" rx="8" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M 32 32 L 36 20 Q 36 12 43 12 L 57 12 Q 64 12 64 20 L 68 32" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M 94 44 L 56 44 Q 50 44 50 51 Q 50 58 56 58 L 94 58" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'

const X_ICON_ID = 'qc-x-brand'
const X_ICON_SVG = '<path fill="currentColor" transform="scale(4.16667)" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.746l7.73-8.835L1.254 2.25H8.08l4.259 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>'

export default class QuickClipCapturePlugin extends Plugin {
    settings!: PluginSettings

    async onload(): Promise<void> {
        await this.loadSettings()
        addIcon(QC_ICON_ID, QC_ICON_SVG)
        addIcon(X_ICON_ID, X_ICON_SVG)
        this.injectCalloutColors()

        this.registerView(
            VIEW_CLIP_MANAGER,
            (leaf) => new ClipManagerView(leaf, this)
        )

        this.registerMarkdownPostProcessor((el, ctx) => {
            processHighlight(this.app, el, ctx, () => this.settings.confirmDelete)
            processFullPage(this.app, el, ctx)
        })

        // Re-scan on leaf change to handle Obsidian's reading view cache resets
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (!leaf) return
                const view = leaf.view
                if (!(view instanceof MarkdownView)) return
                if (view.getMode() !== 'preview') return

                setTimeout(() => {
                    const section = view.containerEl.querySelector('.markdown-preview-section')
                    if (section) scanAndTransform(this.app, section as HTMLElement, view.file?.path ?? '', () => this.settings.confirmDelete)
                    injectFullPageHeader(this.app, view.containerEl, view.file?.path ?? '')
                    injectVideoClipView(this.app, view.containerEl, view.file?.path ?? '', () => this.settings.confirmDelete)
                }, 100)
            })
        )

        // Re-inject video embed when the open file is modified externally (e.g. extension saving a new clip)
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (!(file instanceof TFile)) return
                const view = this.app.workspace.getActiveViewOfType(MarkdownView)
                if (!view || view.getMode() !== 'preview') return
                if (view.file?.path !== file.path) return
                setTimeout(() => {
                    injectVideoClipView(this.app, view.containerEl, file.path, () => this.settings.confirmDelete)
                }, 300)
            })
        )

        // Also handle switching to Reading view within the same leaf
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView)
                if (!view || view.getMode() !== 'preview') return
                injectFullPageHeader(this.app, view.containerEl, view.file?.path ?? '')
                injectVideoClipView(this.app, view.containerEl, view.file?.path ?? '', () => this.settings.confirmDelete)
            })
        )

        this.addSettingTab(new QuickClipSettingTab(this.app, this))

        if (this.settings.autoOpenOnStartup)
            this.app.workspace.onLayoutReady(() => this.activateView())

        this.addRibbonIcon(QC_ICON_ID, 'QuickClip Capture Manager', () => this.activateView())

        this.addCommand({
            id: 'open-manager',
            name: 'Open clip manager',
            callback: () => this.activateView(),
        })
    }

    onunload(): void {
        for (const type of Object.keys(DEFAULT_CALLOUT_COLORS)) {
            activeDocument.body.style.removeProperty(`--qc-color-${type}`)
        }
    }

    injectCalloutColors(): void {
        const colors = { ...DEFAULT_CALLOUT_COLORS, ...this.settings.calloutColors }
        for (const [type, hex] of Object.entries(colors)) {
            const [r, g, b] = hexToRgb(hex)
            activeDocument.body.style.setProperty(`--qc-color-${type}`, `${r}, ${g}, ${b}`)
        }
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
        // Ensure calloutColors has all keys (handles upgrades from older versions)
        this.settings.calloutColors = { ...DEFAULT_CALLOUT_COLORS, ...this.settings.calloutColors }
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings)
    }

    private async activateView(): Promise<void> {
        const { workspace } = this.app
        const existing = workspace.getLeavesOfType(VIEW_CLIP_MANAGER)[0]
        if (existing) { workspace.revealLeaf(existing); return }

        const leaf = workspace.getLeaf(false)
        await leaf.setViewState({ type: VIEW_CLIP_MANAGER, active: true })
        workspace.revealLeaf(leaf)
    }
}
