import { App, TFile } from 'obsidian'
import { ClipsIndex, ClipRef, Clip, ContentType } from './types'

const INDEX_PATH = '.quickclip/clipsHistory.json'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export async function loadIndex(app: App): Promise<ClipsIndex> {
    try {
        const raw = await app.vault.adapter.read(INDEX_PATH)
        const parsed = JSON.parse(raw)
        return typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch {
        return {}
    }
}

export async function saveIndex(app: App, index: ClipsIndex): Promise<void> {
    await app.vault.adapter.write(INDEX_PATH, JSON.stringify(index, null, 2))
}

export function getAllClips(index: ClipsIndex): ClipRef[] {
    const refs: ClipRef[] = []
    for (const [url, entry] of Object.entries(index)) {
        for (const clip of entry.clips) {
            refs.push({ url, clip, pageTitle: entry.title, domain: entry.domain, content_type: entry.content_type })
        }
    }
    return refs.sort((a, b) => b.clip.savedAt.localeCompare(a.clip.savedAt))
}

export async function deleteClip(app: App, url: string, hash: string): Promise<void> {
    const index = await loadIndex(app)
    const entry = index[url]
    if (!entry) return

    const clip = entry.clips.find(c => c.hash === hash)
    if (!clip) return

    entry.clips = entry.clips.filter(c => c.hash !== hash)
    if (entry.clips.length === 0) {
        delete index[url]
    }
    await saveIndex(app, index)

    const isWholeFile = clip.clip_type === 'full-page' || clip.clip_type === 'transcript' || clip.clip_type === 'tweet'
    if (isWholeFile) {
        const file = app.vault.getAbstractFileByPath(clip.path)
        if (file instanceof TFile) await app.vault.delete(file)
    } else {
        await removeHighlightFromFile(app, clip)
    }
}

export async function updateContentType(app: App, url: string, contentType: ContentType): Promise<void> {
    const index = await loadIndex(app)
    if (index[url]) {
        index[url].content_type = contentType
        await saveIndex(app, index)
    }
}

export async function updateClipTags(app: App, url: string, hash: string, tags: string[]): Promise<void> {
    const index = await loadIndex(app)
    const entry = index[url]
    if (!entry) return
    const clip = entry.clips.find(c => c.hash === hash)
    if (!clip) return
    clip.tags = tags
    await saveIndex(app, index)
    await updateTagsInFile(app, clip, tags)
}

async function updateTagsInFile(app: App, clip: Clip, tags: string[]): Promise<void> {
    const file = app.vault.getAbstractFileByPath(clip.path)
    if (!(file instanceof TFile)) return

    if (clip.clip_type === 'full-page') {
        await updateFullPageTags(app, file, tags)
    } else {
        await updateHighlightTags(app, file, clip, tags)
    }
}

async function updateFullPageTags(app: App, file: TFile, tags: string[]): Promise<void> {
    const content = await app.vault.read(file)
    const lines = content.split('\n')
    if (lines[0] !== '---') return
    const fmEnd = lines.indexOf('---', 1)
    if (fmEnd === -1) return

    const tagsLine = tags.length
        ? `tags: [${tags.map(t => t.replace(/^#/, '')).join(', ')}]`
        : null
    const tagsIdx = lines.findIndex((l, i) => i > 0 && i < fmEnd && l.startsWith('tags:'))

    let newLines: string[]
    if (tagsIdx !== -1) {
        if (tagsLine) {
            newLines = [...lines]; newLines[tagsIdx] = tagsLine
        } else {
            newLines = lines.filter((_, i) => i !== tagsIdx)
        }
    } else if (tagsLine) {
        const clippedIdx = lines.findIndex((l, i) => i > 0 && i < fmEnd && l.startsWith('clipped:'))
        const insertAt = clippedIdx !== -1 ? clippedIdx + 1 : fmEnd
        newLines = [...lines.slice(0, insertAt), tagsLine, ...lines.slice(insertAt)]
    } else {
        return
    }

    await app.vault.modify(file, newLines.join('\n'))
}

async function updateHighlightTags(app: App, file: TFile, clip: Clip, tags: string[]): Promise<void> {
    const content = await app.vault.read(file)
    const lines = content.split('\n')

    const date = new Date(clip.savedAt)
    const capturedStr = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} \\| ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
    const capturedIdx = lines.findIndex(l => l.includes(`| Captured | ${capturedStr} |`))
    if (capturedIdx === -1) return

    let blockEnd = lines.length
    for (let i = capturedIdx + 1; i < lines.length; i++) {
        if (lines[i] === '---') { blockEnd = i; break }
    }

    const tagsIdx = lines.findIndex((l, i) => i > capturedIdx && i < blockEnd && l.startsWith('| Tags |'))
    const tagsLine = tags.length
        ? `| Tags | ${tags.map(t => t.startsWith('#') ? t : `#${t}`).join(' ')} |`
        : null

    let newLines: string[]
    if (tagsIdx !== -1) {
        if (tagsLine) {
            newLines = [...lines]; newLines[tagsIdx] = tagsLine
        } else {
            newLines = lines.filter((_, i) => i !== tagsIdx)
        }
    } else if (tagsLine) {
        newLines = [...lines.slice(0, capturedIdx + 1), tagsLine, ...lines.slice(capturedIdx + 1)]
    } else {
        return
    }

    await app.vault.modify(file, newLines.join('\n'))
}

async function removeHighlightFromFile(app: App, clip: Clip): Promise<void> {
    const file = app.vault.getAbstractFileByPath(clip.path)
    if (!(file instanceof TFile)) return

    const content = await app.vault.read(file)
    const date = new Date(clip.savedAt)
    const capturedStr = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} \\| ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
    const capturedMarker = `| Captured | ${capturedStr} |`

    if (!content.includes(capturedMarker)) return

    const lines = content.split('\n')
    const capturedLineIdx = lines.findIndex(l => l.includes(capturedMarker))
    if (capturedLineIdx === -1) return

    // Walk backwards to find the > [!quote] Clip line
    let blockStart = capturedLineIdx
    for (let i = capturedLineIdx - 1; i >= 0; i--) {
        if (lines[i].startsWith('> [!quote]')) {
            blockStart = i
            break
        }
    }

    // Include optional > [!note] block immediately before the callout
    if (blockStart > 0 && lines[blockStart - 1].startsWith('> ') || lines[blockStart - 1] === '') {
        // walk back further to catch note block
        for (let i = blockStart - 1; i >= 0; i--) {
            if (lines[i].startsWith('> [!note]')) {
                blockStart = i
                break
            }
            if (!lines[i].startsWith('>') && lines[i] !== '') break
        }
    }

    // Walk forwards to find the --- separator
    let blockEnd = capturedLineIdx
    for (let i = capturedLineIdx + 1; i < lines.length; i++) {
        if (lines[i] === '---') {
            blockEnd = i + 1
            // consume the blank line after ---
            if (i + 1 < lines.length && lines[i + 1] === '') blockEnd = i + 2
            break
        }
    }

    // Also consume the blank line before the block
    const startWithBlank = blockStart > 0 && lines[blockStart - 1] === '' ? blockStart - 1 : blockStart

    const afterRemoval = [
        ...lines.slice(0, startWithBlank),
        ...lines.slice(blockEnd),
    ].join('\n')

    await app.vault.modify(file, removeOrphanedHeadings(afterRemoval))
}

function removeOrphanedHeadings(content: string): string {
    const lines = content.split('\n')
    const toRemove = new Set<number>()

    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('# ')) continue
        // Find where the next heading starts (or EOF)
        let j = i + 1
        while (j < lines.length && !lines[j].startsWith('# ')) j++
        // Heading is orphaned if everything between it and the next heading is blank
        const hasContent = lines.slice(i + 1, j).some(l => l.trim() !== '')
        if (!hasContent) toRemove.add(i)
    }

    return lines.filter((_, i) => !toRemove.has(i)).join('\n')
}
