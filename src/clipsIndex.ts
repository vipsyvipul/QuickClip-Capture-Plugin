import { App, TFile } from 'obsidian'
import { ClipsIndex, ClipRef, Clip, ContentType } from './types'

const INDEX_PATH = '.quickclip/clipsHistory.json'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

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
    const isLastClip = entry.clips.length === 0
    if (isLastClip) delete index[url]
    await saveIndex(app, index)

    if (clip.clip_type === 'full-page' || clip.clip_type === 'transcript') {
        const file = app.vault.getAbstractFileByPath(clip.path)
        if (file instanceof TFile) await app.vault.delete(file)
    } else if (clip.clip_type === 'video-clip') {
        // Never delete the video file — the embed and table structure should remain
        await removeVideoClipRow(app, clip)
    } else {
        // highlight, pdf-highlight, tweet, image — all appended callout blocks
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

export async function updateClipNote(app: App, url: string, hash: string, noteText: string): Promise<void> {
    const index = await loadIndex(app)
    const entry = index[url]
    if (!entry) return
    const clip = entry.clips.find(c => c.hash === hash)
    if (!clip) return
    const file = app.vault.getAbstractFileByPath(clip.path)
    if (!(file instanceof TFile)) return
    if (clip.clip_type === 'full-page') {
        await updateFullPageNote(app, file, noteText)
    } else if (clip.clip_type === 'video-clip') {
        await updateVideoClipNote(app, file, clip, noteText)
    } else {
        await updateHighlightNote(app, file, clip, noteText)
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
    } else if (clip.clip_type === 'video-clip') {
        await updateVideoClipTags(app, file, clip, tags)
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

// Identifies a video-clip table row using Clip Timeline date + start_time as compound key.
// Falls back to date-only if start_time is absent, but the compound key is required to
// disambiguate clips from the same video saved within the same minute.
function findVideoClipRowIdx(lines: string[], clip: Clip): number {
    const date = new Date(clip.savedAt)
    const dateStr = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} \\| ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
    if (clip.start_time != null) {
        const h = Math.floor(clip.start_time / 3600)
        const m = Math.floor((clip.start_time % 3600) / 60)
        const s = Math.floor(clip.start_time % 60)
        const timeText = h > 0
            ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
            : `${m}:${String(s).padStart(2,'0')}`
        const idx = lines.findIndex(l => l.includes(`| ${dateStr} |`) && l.includes(`[${timeText}]`))
        if (idx !== -1) return idx
    }
    return lines.findIndex(l => l.includes(`| ${dateStr} |`))
}

async function removeVideoClipRow(app: App, clip: Clip): Promise<void> {
    const file = app.vault.getAbstractFileByPath(clip.path)
    if (!(file instanceof TFile)) return

    const content = await app.vault.read(file)
    const lines = content.split('\n')
    const rowIdx = findVideoClipRowIdx(lines, clip)
    if (rowIdx === -1) return

    await app.vault.modify(file, lines.filter((_, i) => i !== rowIdx).join('\n'))
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
        if (lines[i].startsWith('> [!quote]') || lines[i].startsWith('> [!clip]')) {
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

async function updateFullPageNote(app: App, file: TFile, noteText: string): Promise<void> {
    const content = await app.vault.read(file)
    const lines = content.split('\n')
    if (lines[0] !== '---') return
    const fmEnd = lines.indexOf('---', 1)
    if (fmEnd === -1) return

    const noteIdx = lines.findIndex((l, i) => i > fmEnd && /^>\s*\[!note\]/i.test(l))

    if (noteText) {
        const newBlock = [`> [!note]`, ...noteText.split('\n').map(l => `> ${l}`)]
        if (noteIdx !== -1) {
            let noteEnd = noteIdx + 1
            while (noteEnd < lines.length && lines[noteEnd].startsWith('>')) noteEnd++
            lines.splice(noteIdx, noteEnd - noteIdx, ...newBlock)
        } else {
            const insertAt = lines.findIndex((l, i) => i > fmEnd + 1 && l.trim() !== '')
            const pos = insertAt !== -1 ? insertAt : fmEnd + 1
            lines.splice(pos, 0, ...newBlock, '')
        }
    } else if (noteIdx !== -1) {
        let noteEnd = noteIdx + 1
        while (noteEnd < lines.length && lines[noteEnd].startsWith('>')) noteEnd++
        if (noteEnd < lines.length && lines[noteEnd] === '') noteEnd++
        lines.splice(noteIdx, noteEnd - noteIdx)
    }

    await app.vault.modify(file, lines.join('\n'))
}

async function updateHighlightNote(app: App, file: TFile, clip: Clip, noteText: string): Promise<void> {
    const content = await app.vault.read(file)
    const lines = content.split('\n')

    const date = new Date(clip.savedAt)
    const capturedStr = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()} \\| ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`
    const capturedIdx = lines.findIndex(l => l.includes(`| Captured | ${capturedStr} |`))
    if (capturedIdx === -1) return

    let quoteIdx = -1
    for (let i = capturedIdx - 1; i >= 0; i--) {
        if (lines[i].startsWith('> [!quote]') || lines[i].startsWith('> [!clip]')) { quoteIdx = i; break }
    }
    if (quoteIdx === -1) return

    // Find [!note] block immediately before [!quote]
    let noteBlockStart = -1
    let i = quoteIdx - 1
    while (i >= 0 && lines[i] === '') i--
    while (i >= 0 && lines[i].startsWith('>') && !/^>\s*\[!/.test(lines[i])) i--
    if (i >= 0 && /^>\s*\[!note\]/i.test(lines[i])) noteBlockStart = i

    if (noteText) {
        const newBlock = [`> [!note]`, ...noteText.split('\n').map(l => `> ${l}`), '']
        if (noteBlockStart !== -1) {
            lines.splice(noteBlockStart, quoteIdx - noteBlockStart, ...newBlock)
        } else {
            lines.splice(quoteIdx, 0, ...newBlock)
        }
    } else if (noteBlockStart !== -1) {
        lines.splice(noteBlockStart, quoteIdx - noteBlockStart)
    }

    await app.vault.modify(file, lines.join('\n'))
}

async function updateVideoClipNote(app: App, file: TFile, clip: Clip, noteText: string): Promise<void> {
    const content = await app.vault.read(file)
    const lines = content.split('\n')
    const rowIdx = findVideoClipRowIdx(lines, clip)
    if (rowIdx === -1) return
    // Row: "| [link](url) | date | note | tags |" → split by " | " → 4 parts
    const parts = lines[rowIdx].split(' | ')
    if (parts.length < 4) return
    parts[2] = noteText.replace(/\n/g, '<br>')
    lines[rowIdx] = parts.join(' | ')
    await app.vault.modify(file, lines.join('\n'))
}

async function updateVideoClipTags(app: App, file: TFile, clip: Clip, tags: string[]): Promise<void> {
    const content = await app.vault.read(file)
    const lines = content.split('\n')
    const rowIdx = findVideoClipRowIdx(lines, clip)
    if (rowIdx === -1) return
    // Row: "| [link](url) | date | note | tags |" → split by " | " → 4 parts
    const parts = lines[rowIdx].split(' | ')
    if (parts.length < 4) return
    const tagsStr = tags.map(t => t.startsWith('#') ? t : `#${t}`).join(' ')
    parts[3] = tagsStr ? `${tagsStr} |` : ' |'
    lines[rowIdx] = parts.join(' | ')
    await app.vault.modify(file, lines.join('\n'))
}

function removeOrphanedHeadings(content: string): string {
    const lines = content.split('\n')
    const toRemove = new Set<number>()
    const isHeading = (l: string) => /^#{1,6} /.test(l)

    for (let i = 0; i < lines.length; i++) {
        if (!isHeading(lines[i])) continue
        // Find where the next heading starts (or EOF)
        let j = i + 1
        while (j < lines.length && !isHeading(lines[j])) j++
        // Heading is orphaned if everything between it and the next heading is blank
        const hasContent = lines.slice(i + 1, j).some(l => l.trim() !== '')
        if (!hasContent) toRemove.add(i)
    }

    return lines.filter((_, i) => !toRemove.has(i)).join('\n')
}
