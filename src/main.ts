import { MarkdownView, Plugin } from 'obsidian'
import { processHighlight, scanAndTransform } from './renderers/highlight'
import { processFullPage, injectFullPageHeader } from './renderers/fullPage'
import { ClipManagerView, VIEW_CLIP_MANAGER } from './views/ClipManagerView'

export interface PluginSettings {
    visibleColumns: string[]
    columnOrder: string[]
    filterFormat: string
    filterSource: string
    filterDate: string
}

const DEFAULT_SETTINGS: PluginSettings = {
    visibleColumns: ['clip_type', 'page_title', 'domain', 'saved_at'],
    columnOrder: [],
    filterFormat: '',
    filterSource: '',
    filterDate: '',
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
            processHighlight(el, ctx)
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
                    if (section) scanAndTransform(section as HTMLElement)
                    injectFullPageHeader(this.app, view.containerEl, view.file?.path ?? '')
                }, 100)
            })
        )

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
