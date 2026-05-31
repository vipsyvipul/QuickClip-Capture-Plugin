import { App, PluginSettingTab, Setting, TFile } from 'obsidian'
import QuickClipCapturePlugin from './main'
import { VIEW_CLIP_MANAGER } from './views/ClipManagerView'
import { migrateOldFormatClips, MigrationClipResult } from './migration'

export class QuickClipSettingTab extends PluginSettingTab {
    constructor(app: App, private plugin: QuickClipCapturePlugin) {
        super(app, plugin)
    }

    display(): void {
        const { containerEl } = this
        containerEl.empty()

        containerEl.createEl('h3', { text: 'Clip Manager' })

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

        containerEl.createEl('h3', { text: 'Editing' })

        new Setting(containerEl)
            .setName('Confirm before delete')
            .setDesc('Show a confirmation prompt before deleting a clip.')
            .addToggle(t => t
                .setValue(this.plugin.settings.confirmDelete)
                .onChange(async val => {
                    this.plugin.settings.confirmDelete = val
                    await this.plugin.saveSettings()
                }))

        containerEl.createEl('h3', { text: 'Migration' })
        containerEl.createEl('p', {
            text: 'Convert clips saved in the old [!quote] format to the new qc_* nested callout format. Clips already in the new format are skipped. This cannot be undone — back up your vault first.',
            cls: 'setting-item-description',
        })

        const migrateBtn = containerEl.createEl('button', { text: 'Migrate clips to new format', cls: 'mod-cta' })
        const statusEl   = containerEl.createDiv({ cls: 'qc-migrate-status' })

        // Render persisted results from last run
        if (this.plugin.settings.lastMigrationReport) {
            this.renderMigrationResults(statusEl, this.plugin.settings.lastMigrationReport)
        }

        migrateBtn.addEventListener('click', async () => {
            migrateBtn.disabled = true
            migrateBtn.setText('Migrating…')
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
                migrateBtn.disabled = false
                migrateBtn.setText('Migrate clips to new format')
                return
            }

            const stored = {
                migrated: report.migrated,
                skipped: report.skipped,
                timestamp: new Date().toISOString(),
                results: report.results,
            }
            this.plugin.settings.lastMigrationReport = stored
            await this.plugin.saveSettings()

            statusEl.empty()
            this.renderMigrationResults(statusEl, stored)

            migrateBtn.disabled = false
            migrateBtn.setText('Migrate clips to new format')
        })
    }

    private renderMigrationResults(statusEl: HTMLElement, report: { migrated: number; skipped: number; timestamp?: string; results: Array<{ filePath: string; preview: string; status: string; reason: string }> }): void {
        const summary = statusEl.createEl('p', { cls: 'qc-migrate-summary' })
        let summaryText = `✓ ${report.migrated} clip${report.migrated !== 1 ? 's' : ''} migrated`
        if (report.skipped > 0) summaryText += `, ${report.skipped} file${report.skipped !== 1 ? 's' : ''} already up to date`
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
