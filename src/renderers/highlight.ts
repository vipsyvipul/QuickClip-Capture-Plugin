import { MarkdownPostProcessorContext, MarkdownRenderChild } from 'obsidian'

export function processHighlight(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    if (el.closest('.cm-editor')) return
    if (!el.querySelector('[data-callout="quote"]')) return
    ctx.addChild(new HighlightScanner(el))
}

class HighlightScanner extends MarkdownRenderChild {
    onload(): void {
        const tryTransform = () => {
            if (!this.containerEl.parentElement) {
                requestAnimationFrame(tryTransform)
                return
            }
            transformSection(this.containerEl)
        }
        tryTransform()
    }
}

function transformSection(calloutSection: HTMLElement): void {
    if (calloutSection.querySelector('.qc-highlight-card')) return

    const callout = calloutSection.querySelector<HTMLElement>('[data-callout="quote"]')
    if (!callout) return

    const tableSection = calloutSection.nextElementSibling as HTMLElement | null
    if (!tableSection) return

    const table = tableSection.querySelector('table')
    if (!table) return

    const rows = Array.from(table.querySelectorAll('tr'))
    const hasCaptured = rows.some(r => (r.cells[0]?.textContent?.trim() ?? '') === 'Captured')
    if (!hasCaptured) return

    const prevSection = calloutSection.previousElementSibling as HTMLElement | null
    const noteSection = prevSection?.querySelector('[data-callout="note"]') ? prevSection : null

    buildCard(calloutSection, tableSection, callout, table as HTMLTableElement, noteSection)
}

// Called from main.ts on active-leaf-change to re-apply after Obsidian cache resets
export function scanAndTransform(container: HTMLElement): void {
    const sections = Array.from(container.querySelectorAll('[data-callout="quote"]'))
    sections.forEach(callout => {
        const section = callout.closest('.el-div, .el-blockquote, div') as HTMLElement | null
        if (section && section.parentElement === container) {
            transformSection(section)
        }
    })
}

function buildCard(
    calloutSection: HTMLElement,
    tableSection: HTMLElement,
    callout: HTMLElement,
    table: HTMLTableElement,
    noteSection: HTMLElement | null
): void {
    const contentEl = callout.querySelector('.callout-content')
    if (!contentEl) return

    let viewHref = ''
    let captured = ''
    const tags: string[] = []

    for (const row of Array.from(table.querySelectorAll('tr'))) {
        const key = row.cells[0]?.textContent?.trim() ?? ''
        const valueCell = row.cells[1]

        if (key === 'Open') {
            viewHref = valueCell?.querySelector('a')?.href ?? ''
        } else if (key === 'Captured') {
            captured = (valueCell?.textContent?.trim() ?? '').replace(' | ', ' · ')
        } else if (key === 'Tags') {
            valueCell?.textContent?.split(/\s+/).filter(Boolean).forEach(t => tags.push(t))
        }
    }

    // Quote block
    const quoteBlock = document.createElement('div')
    quoteBlock.className = 'qc-quote-block'

    const quoteIcon = document.createElement('span')
    quoteIcon.className = 'qc-quote-icon'
    quoteIcon.textContent = '❝'

    const quoteEl = document.createElement('div')
    quoteEl.className = 'qc-highlight-quote'
    quoteEl.innerHTML = contentEl.innerHTML

    const hasOnlyImage = !!(quoteEl.querySelector('img')) && (quoteEl.textContent?.trim() ?? '') === ''
    if (hasOnlyImage) quoteEl.classList.add('qc-highlight-quote--image')

    quoteBlock.appendChild(quoteIcon)
    quoteBlock.appendChild(quoteEl)

    // Footer
    const footer = document.createElement('div')
    footer.className = 'qc-highlight-footer'

    if (tags.length) {
        const sep1 = document.createElement('hr')
        sep1.className = 'qc-sep'
        const tagsEl = document.createElement('div')
        tagsEl.className = 'qc-highlight-tags'
        tags.forEach(tag => {
            const chip = document.createElement('a')
            chip.className = 'tag'
            chip.textContent = tag
            chip.href = tag
            tagsEl.appendChild(chip)
        })
        footer.appendChild(sep1)
        footer.appendChild(tagsEl)
    }

    const sep2 = document.createElement('hr')
    sep2.className = 'qc-sep'

    const actionsEl = document.createElement('div')
    actionsEl.className = 'qc-highlight-actions'

    if (viewHref) {
        const link = document.createElement('a')
        link.href = viewHref
        link.className = 'qc-view-link external-link'
        link.textContent = 'View at source ↗'
        link.target = '_blank'
        link.rel = 'noopener'
        actionsEl.appendChild(link)
    }

    if (captured) {
        const capturedEl = document.createElement('span')
        capturedEl.className = 'qc-captured'
        capturedEl.textContent = captured
        actionsEl.appendChild(capturedEl)
    }

    footer.appendChild(sep2)
    footer.appendChild(actionsEl)

    const card = document.createElement('div')
    card.className = 'qc-highlight-card'

    if (noteSection) {
        const noteCallout = noteSection.querySelector('[data-callout="note"]')
        if (noteCallout) {
            const cloned = noteCallout.cloneNode(true) as HTMLElement
            cloned.classList.add('qc-note-callout')

            // Remove "Note" title text
            cloned.querySelector('.callout-title-inner')?.remove()

            // Move content nodes inline into the title (after the icon)
            const calloutTitle = cloned.querySelector<HTMLElement>('.callout-title')
            const calloutContent = cloned.querySelector<HTMLElement>('.callout-content')
            if (calloutTitle && calloutContent) {
                Array.from(calloutContent.childNodes).forEach(n => calloutTitle.appendChild(n))
                calloutContent.remove()
            }

            card.appendChild(cloned)
        }
        noteSection.style.display = 'none'
    }

    card.appendChild(quoteBlock)
    card.appendChild(footer)

    calloutSection.innerHTML = ''
    calloutSection.appendChild(card)
    tableSection.classList.add('qc-table-hidden')
    tableSection.style.display = 'none'
}
