import { App, Modal } from 'obsidian'

export class ConfirmModal extends Modal {
    constructor(app: App, private message: string, private onConfirm: () => void) {
        super(app)
    }

    onOpen(): void {
        this.contentEl.createEl('p', { text: this.message })
        const btnRow = this.contentEl.createDiv({ cls: 'modal-button-container' })
        btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close())
        const confirmBtn = btnRow.createEl('button', { text: 'Delete', cls: 'mod-warning' })
        confirmBtn.addEventListener('click', () => { this.close(); this.onConfirm() })
    }

    onClose(): void { this.contentEl.empty() }
}
