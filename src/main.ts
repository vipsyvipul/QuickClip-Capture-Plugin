import { MarkdownView, Plugin } from 'obsidian'
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
    confirmDelete: boolean
    rowDensity: 'compact' | 'comfortable' | 'spacious'
    snippetLength: number
    dateFormat: 'absolute' | 'relative' | 'full'
    filePathDisplay: 'full' | 'filename'
    autoOpenOnStartup: boolean
}

const DEFAULT_SETTINGS: PluginSettings = {
    visibleColumns: ['clip_type', 'page_title', 'domain', 'saved_at'],
    columnOrder: [],
    filterFormat: '',
    filterSource: '',
    filterDate: '',
    confirmDelete: false,
    rowDensity: 'comfortable',
    snippetLength: 20,
    dateFormat: 'absolute',
    filePathDisplay: 'full',
    autoOpenOnStartup: false,
}

export default class QuickClipCapturePlugin extends Plugin {
    settings!: PluginSettings

    async onload(): Promise<void> {
        await this.loadSettings()

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
                    injectVideoClipView(this.app, view.containerEl, view.file?.path ?? '')
                }, 100)
            })
        )

        // Also handle switching to Reading view within the same leaf
        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView)
                if (!view || view.getMode() !== 'preview') return
                injectVideoClipView(this.app, view.containerEl, view.file?.path ?? '')
            })
        )

        this.addSettingTab(new QuickClipSettingTab(this.app, this))

        if (this.settings.autoOpenOnStartup)
            this.app.workspace.onLayoutReady(() => this.activateView())

        this.addRibbonIcon('scissors', 'QuickClip Capture', () => this.activateView())

        this.addCommand({
            id: 'open-manager',
            name: 'Open clip manager',
            callback: () => this.activateView(),
        })
    }

    onunload(): void {
        this.app.workspace.detachLeavesOfType(VIEW_CLIP_MANAGER)
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
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
