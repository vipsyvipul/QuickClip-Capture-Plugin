import { App, PluginSettingTab, Setting, TFile, setIcon } from 'obsidian'
import QuickClipCapturePlugin, { DEFAULT_CALLOUT_COLORS } from './main'
import { VIEW_CLIP_MANAGER } from './views/ClipManagerView'
import { migrateOldFormatClips, migrateOldFormatFile, scanOldFormatFiles, MigrationClipResult } from './migration'

const CALLOUT_COLOR_ROWS: { key: string; label: string }[] = [
    { key: 'qc_highlight',     label: 'Highlight' },
    { key: 'qc_tweet',         label: 'Tweet' },
    { key: 'qc_pdf_highlight', label: 'PDF Highlight' },
    { key: 'qc_image',         label: 'Image' },
    { key: 'qc_note',          label: 'Note (child callout)' },
    { key: 'qc_details',       label: 'Details (child callout)' },
]

export class QuickClipSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: QuickClipCapturePlugin) {
        super(app, plugin)
    }

    display(): void {
        const { containerEl } = this
        containerEl.empty()

        containerEl.createEl('h3', { text: 'Capture Settings' })

        new Setting(containerEl)
            .setName('Auto-open on startup')
            .setDesc('Open the clip manager when Obsidian starts.')
            .addToggle(t => t
                .setValue(this.plugin.settings.autoOpenOnStartup)
                .onChange(async val => {
                    this.plugin.settings.autoOpenOnStartup = val
                    await this.plugin.saveSettings()
                }))

        new Setting(containerEl)
            .setName('Row density')
            .setDesc('Cell padding in the clip table.')
            .addDropdown(d => d
                .addOption('compact', 'Compact')
                .addOption('comfortable', 'Comfortable')
                .addOption('spacious', 'Spacious')
                .setValue(this.plugin.settings.rowDensity)
                .onChange(async val => {
                    this.plugin.settings.rowDensity = val as 'compact' | 'comfortable' | 'spacious'
                    await this.plugin.saveSettings()
                    this.rerenderView()
                }))

        new Setting(containerEl)
            .setName('Snippet length')
            .setDesc('Characters shown in the Clip column (15–60).')
            .addSlider(s => s
                .setLimits(15, 60, 1)
                .setValue(this.plugin.settings.snippetLength)
                .setDynamicTooltip()
                .onChange(async val => {
                    this.plugin.settings.snippetLength = val
                    await this.plugin.saveSettings()
                    this.rerenderView()
                }))

        new Setting(containerEl)
            .setName('Date format')
            .addDropdown(d => d
                .addOption('absolute', 'Absolute (21 May)')
                .addOption('relative', 'Relative (3 days ago)')
                .addOption('full', 'Full (21 May 2026)')
                .setValue(this.plugin.settings.dateFormat)
                .onChange(async val => {
                    this.plugin.settings.dateFormat = val as 'absolute' | 'relative' | 'full'
                    await this.plugin.saveSettings()
                    this.rerenderView()
                }))

        new Setting(containerEl)
            .setName('File path display')
            .addDropdown(d => d
                .addOption('full', 'Full path')
                .addOption('filename', 'Filename only')
                .setValue(this.plugin.settings.filePathDisplay)
                .onChange(async val => {
                    this.plugin.settings.filePathDisplay = val as 'full' | 'filename'
                    await this.plugin.saveSettings()
                    this.rerenderView()
                }))

        new Setting(containerEl)
            .setName('Confirm before delete')
            .setDesc('Show a confirmation prompt before deleting a clip.')
            .addToggle(t => t
                .setValue(this.plugin.settings.confirmDelete)
                .onChange(async val => {
                    this.plugin.settings.confirmDelete = val
                    await this.plugin.saveSettings()
                }))

        // ── Callout Colors (collapsible) ─────────────────────────────────────
        const details = containerEl.createEl('details', { cls: 'qc-colors-details' })
        const summary = details.createEl('summary', { cls: 'qc-colors-summary' })
        const summaryH3 = summary.createEl('h3', { text: 'Callout Colors' })
        summaryH3.style.margin = '0'

        const colorInputs: Record<string, HTMLInputElement> = {}
        const colorResetUpdaters: Array<() => void> = []
        let colorSaveTimer: ReturnType<typeof setTimeout> | null = null

        for (const { key, label } of CALLOUT_COLOR_ROWS) {
            const s = new Setting(details).setName(label)
            const input = s.controlEl.createEl('input', { type: 'color', cls: 'qc-color-input' })
            input.value = this.plugin.settings.calloutColors[key] ?? DEFAULT_CALLOUT_COLORS[key]
            colorInputs[key] = input

            // Per-row reset — visible only when color differs from default
            const rowReset = s.controlEl.createEl('button', { cls: 'qc-color-row-reset' })
            setIcon(rowReset, 'rotate-ccw')
            rowReset.title = `Reset ${label} to default`
            const updateRowReset = () => {
                rowReset.style.display =
                    this.plugin.settings.calloutColors[key] !== DEFAULT_CALLOUT_COLORS[key] ? '' : 'none'
            }
            updateRowReset()
            colorResetUpdaters.push(updateRowReset)
            input.addEventListener('input', () => {
                this.plugin.settings.calloutColors[key] = input.value
                this.plugin.injectCalloutColors()
                updateRowReset()
                if (colorSaveTimer) clearTimeout(colorSaveTimer)
                colorSaveTimer = setTimeout(() => { this.plugin.saveSettings() }, 300)
            })
            rowReset.addEventListener('click', async () => {
                this.plugin.settings.calloutColors[key] = DEFAULT_CALLOUT_COLORS[key]
                input.value = DEFAULT_CALLOUT_COLORS[key]
                await this.plugin.saveSettings()
                this.plugin.injectCalloutColors()
                updateRowReset()
            })
        }

        new Setting(details)
            .addButton(b => b
                .setButtonText('Reset all to defaults')
                .onClick(async () => {
                    this.plugin.settings.calloutColors = { ...DEFAULT_CALLOUT_COLORS }
                    await this.plugin.saveSettings()
                    this.plugin.injectCalloutColors()
                    CALLOUT_COLOR_ROWS.forEach(({ key }) => {
                        if (colorInputs[key]) colorInputs[key].value = DEFAULT_CALLOUT_COLORS[key]
                    })
                    colorResetUpdaters.forEach(fn => fn())
                }))

        // ── Migration (hidden until old clips detected) ──────────────────────
        const migrateSection = containerEl.createDiv({ cls: 'qc-migrate-section' })
        migrateSection.style.display = 'none'

        migrateSection.createEl('h3', { text: 'Migration' })

        const desc = migrateSection.createEl('p', { cls: 'qc-migrate-desc' })
        desc.appendText('The following files contain clips saved in the old format. Migrating rewrites them to use ')
        const calloutLink = desc.createEl('a', { text: 'nested callouts', cls: 'external-link' })
        calloutLink.href = 'https://obsidian.md/help/callouts'
        desc.appendText(' — a cleaner structure that enables per-clip colors, collapsible cards, and richer metadata. This operation cannot be undone.')

        const fileListEl = migrateSection.createDiv({ cls: 'qc-migrate-file-list' })

        const migrateAllBtn = migrateSection.createEl('button', { text: 'Migrate all files', cls: 'mod-cta qc-migrate-all-btn' })
        const statusEl = migrateSection.createDiv({ cls: 'qc-migrate-status' })

        const setAllDisabled = (disabled: boolean) => {
            migrateAllBtn.disabled = disabled
            fileListEl.querySelectorAll<HTMLButtonElement>('.qc-migrate-file-btn')
                .forEach(b => { b.disabled = disabled })
        }

        const renderFileList = (files: { filePath: string; blockCount: number }[]) => {
            fileListEl.empty()
            for (const { filePath, blockCount } of files) {
                const row = fileListEl.createDiv({ cls: 'qc-migrate-file-row' })
                const info = row.createDiv({ cls: 'qc-migrate-file-info' })
                const rawName = filePath.split('/').pop() ?? filePath
                const displayName = rawName.endsWith('.md') ? rawName.slice(0, -3) : rawName
                const nameLink = info.createEl('a', { text: displayName, cls: 'qc-migrate-file-name' })
                nameLink.title = filePath
                nameLink.href = '#'
                nameLink.addEventListener('click', e => {
                    e.preventDefault()
                    const file = this.app.vault.getAbstractFileByPath(filePath)
                    if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file)
                })
                info.createSpan({
                    text: `${blockCount} clip${blockCount !== 1 ? 's' : ''}`,
                    cls: 'qc-migrate-file-count',
                })
                const btn = row.createEl('button', { text: 'Migrate', cls: 'qc-migrate-file-btn' })
                btn.addEventListener('click', async () => {
                    setAllDisabled(true)
                    btn.setText('Migrating…')
                    statusEl.empty()
                    let report
                    try {
                        report = await migrateOldFormatFile(this.app, filePath)
                    } catch (err) {
                        statusEl.createEl('p', { text: `Migration failed: ${err}`, cls: 'qc-migrate-error' })
                        setAllDisabled(false)
                        btn.setText('Migrate')
                        return
                    }
                    statusEl.empty()
                    this.renderMigrationResults(statusEl, { ...report, timestamp: new Date().toISOString() })
                    const remaining = await scanOldFormatFiles(this.app)
                    renderFileList(remaining)
                    setAllDisabled(false)
                    if (remaining.length === 0) migrateSection.style.display = 'none'
                })
            }
        }

        scanOldFormatFiles(this.app).then(files => {
            if (files.length > 0) {
                migrateSection.style.display = ''
                renderFileList(files)
            }
        })

        migrateAllBtn.addEventListener('click', async () => {
            setAllDisabled(true)
            migrateAllBtn.setText('Migrating…')
            statusEl.empty()
            statusEl.createEl('p', {
                text: '⏳ Migration in progress — do not close Obsidian until this is complete.',
                cls: 'qc-migrate-running',
            })

            let report
            try {
                report = await migrateOldFormatClips(this.app)
            } catch (err) {
                statusEl.empty()
                statusEl.createEl('p', { text: `Migration failed: ${err}`, cls: 'qc-migrate-error' })
                setAllDisabled(false)
                migrateAllBtn.setText('Migrate all files')
                return
            }

            const result = {
                migrated: report.migrated,
                skipped: report.skipped,
                timestamp: new Date().toISOString(),
                results: report.results,
            }
            this.plugin.settings.lastMigrationReport = result
            await this.plugin.saveSettings()

            statusEl.empty()
            this.renderMigrationResults(statusEl, result)

            const remaining = await scanOldFormatFiles(this.app)
            renderFileList(remaining)
            setAllDisabled(false)
            if (remaining.length === 0) migrateSection.style.display = 'none'
            else migrateAllBtn.setText('Migrate all files')
        })
    }

    private nothingToMigrate(report: { migrated: number; results: Array<{ status: string }> }): boolean {
        return report.migrated === 0 && report.results.filter(r => r.status !== 'migrated').length === 0
    }

    private renderMigrationResults(statusEl: HTMLElement, report: { migrated: number; skipped: number; timestamp?: string; results: Array<{ filePath: string; preview: string; status: string; reason: string }> }): void {
        const summary = statusEl.createEl('p', { cls: 'qc-migrate-summary' })
        let summaryText: string
        if (this.nothingToMigrate(report)) {
            summaryText = 'No clips to migrate. Seems like you are already saving using the new format.'
        } else {
            summaryText = `✓ ${report.migrated} clip${report.migrated !== 1 ? 's' : ''} migrated`
            if (report.skipped > 0) summaryText += `, ${report.skipped} file${report.skipped !== 1 ? 's' : ''} already up to date`
        }
        if (report.timestamp) {
            const d = new Date(report.timestamp)
            summaryText += ` — ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        }
        summary.setText(summaryText)

        const issues = report.results.filter(r => r.status !== 'migrated')
        if (issues.length > 0) {
            statusEl.createEl('p', {
                text: `${issues.filter(r => r.status === 'error').length} error(s), ${issues.filter(r => r.status === 'warning').length} warning(s):`,
                cls: 'qc-migrate-issues-heading',
            })
            const list = statusEl.createEl('ul', { cls: 'qc-migrate-issues' })
            for (const issue of issues) this.renderIssueItem(list, issue as MigrationClipResult)
        }
    }

    private renderIssueItem(list: HTMLElement, issue: MigrationClipResult): void {
        const li = list.createEl('li', { cls: `qc-migrate-issue qc-migrate-issue--${issue.status}` })

        const tag = li.createEl('span', { cls: 'qc-migrate-issue-tag' })
        tag.setText(issue.status === 'error' ? '✕ Error' : '⚠ Warning')

        li.createEl('span', { text: `"${issue.preview}"`, cls: 'qc-migrate-issue-preview' })
        li.createEl('span', { text: ` — ${issue.reason}`, cls: 'qc-migrate-issue-reason' })

        const link = li.createEl('a', { text: ' Open file', cls: 'qc-migrate-issue-link' })
        link.href = '#'
        link.addEventListener('click', e => {
            e.preventDefault()
            const file = this.app.vault.getAbstractFileByPath(issue.filePath)
            if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file)
        })
    }

    private rerenderView(): void {
        const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_CLIP_MANAGER)
        for (const leaf of leaves) {
            const view = leaf.view as any
            if (typeof view.rerenderTable === 'function') view.rerenderTable()
        }
    }
}
