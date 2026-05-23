import { App, TFile } from 'obsidian'
import { ClipsIndex, ClipRef, Clip } from './types'

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

    if (clip.clip_type === 'full-page') {
        const file = app.vault.getAbstractFileByPath(clip.path)
        if (file instanceof TFile) await app.vault.delete(file)
    } else {
        await removeHighlightFromFile(app, clip)
    }
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
        if (lines[i].startsWith('> [!quote] Clip')) {
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

    const updated = [
        ...lines.slice(0, startWithBlank),
        ...lines.slice(blockEnd),
    ].join('\n')

    await app.vault.modify(file, updated)
}
