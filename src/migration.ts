import { App, TFile } from 'obsidian'
import { loadIndex, saveIndex } from './clipsIndex'
import { Clip, ClipsIndex } from './types'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

export type MigrationStatus = 'migrated' | 'warning' | 'error'

export type MigrationClipResult = {
    filePath: string
    preview: string
    status: MigrationStatus
    reason: string
}

export type MigrationReport = {
    migrated: number
    skipped: number
    results: MigrationClipResult[]  // warnings + errors only
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generateHash(input: string): string {
    let h = 5381
    for (let i = 0; i < input.length; i++) {
        h = (((h << 5) + h) ^ input.charCodeAt(i)) >>> 0
    }
    return h.toString(16).padStart(8, '0').slice(0, 8)
}

function parseCapturedToIso(captured: string): string {
    // "26 May 2026 \| 15:30" → ISO date string
    const clean = captured.replace(/\\\|/g, ' ').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim()
    const m = clean.match(/(\d{1,2})\s+(\w+)\s+(\d{4})\s+(\d{2}):(\d{2})/)
    if (!m) return new Date().toISOString()
    const monthIdx = MONTHS.findIndex(mn => mn.toLowerCase() === m[2].toLowerCase())
    if (monthIdx === -1) return new Date().toISOString()
    return new Date(parseInt(m[3]), monthIdx, parseInt(m[1]), parseInt(m[4]), parseInt(m[5])).toISOString()
}

function formatCaptured(savedAt: string): string {
    const d = new Date(savedAt)
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} \\| ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
}

function clipPreview(lines: string[], max = 50): string {
    const s = lines.join(' ').replace(/\s+/g, ' ').trim()
    return s.length > max ? s.slice(0, max).trimEnd() + '…' : s
}

// Parse a markdown table row, correctly handling \| escaped pipes inside cells
function parseTableRow(line: string): [string, string] | null {
    // Replace escaped pipes with a placeholder so split only hits real column separators
    const unescaped = line.replace(/\\\|/g, '')
    const cells = unescaped.split('|').map(c => c.trim().replace(//g, '\\|')).filter(Boolean)
    if (cells.length < 2 || cells[0] === '---') return null
    return [cells[0], cells[1]]
}

// ─── Old-block detection ─────────────────────────────────────────────────────

type OldBlock = {
    blockStart: number          // first line index (note opener, or callout if no note)
    calloutLine: number         // > [!quote] / > [!clip] line index
    blockEnd: number            // first line index AFTER the block (after --- + blank)
    calloutTitle: string        // e.g. "Clip", "Tweet", "PDF Highlight", "Image"
    contentLines: string[]      // body text (> prefix stripped, empty lines excluded)
    noteLines: string[]         // note text (> prefix stripped)
    tableRows: Map<string, string>
    captured: string
}

function findOldBlocks(lines: string[]): OldBlock[] {
    const blocks: OldBlock[] = []
    let i = 0

    while (i < lines.length) {
        const m = lines[i].match(/^> \[!(quote|clip)\][-+]?\s*(.*)/i)
        if (!m) { i++; continue }

        const calloutLine = i
        const calloutTitle = m[2].trim()

        // ── Find preceding [!note] block ──────────────────────────────────
        let blockStart = calloutLine
        const noteLines: string[] = []
        {
            let j = calloutLine - 1
            while (j >= 0 && lines[j] === '') j--
            if (j >= 0 && lines[j].startsWith('>')) {
                let k = j
                while (k >= 0 && lines[k].startsWith('>') && !/^>\s*\[!/.test(lines[k])) k--
                if (k >= 0 && /^>\s*\[!note\]/i.test(lines[k])) {
                    blockStart = k
                    for (let p = k + 1; p <= j; p++) {
                        const text = lines[p].replace(/^>\s?/, '').trim()
                        if (text) noteLines.push(text)
                    }
                }
            }
        }

        // ── Collect callout body lines ────────────────────────────────────
        const contentLines: string[] = []
        let j = calloutLine + 1
        while (j < lines.length && lines[j].startsWith('>')) {
            const text = lines[j].replace(/^>\s?/, '').trim()
            if (text) contentLines.push(text)
            j++
        }

        // ── Skip blank lines, then collect table rows ─────────────────────
        while (j < lines.length && lines[j].trim() === '') j++

        const tableRows = new Map<string, string>()
        while (j < lines.length && lines[j].startsWith('|')) {
            const parsed = parseTableRow(lines[j])
            if (parsed) tableRows.set(parsed[0], parsed[1])
            j++
        }

        // No metadata table, or no Captured row → not a QuickClip block; skip
        if (tableRows.size === 0 || !tableRows.has('Captured')) { i++; continue }

        // ── Skip blank lines, find --- terminator ─────────────────────────
        while (j < lines.length && lines[j].trim() === '') j++

        let blockEnd = j
        if (j < lines.length && lines[j] === '---') {
            blockEnd = j + 1
            if (blockEnd < lines.length && lines[blockEnd] === '') blockEnd++
        }

        blocks.push({
            blockStart, calloutLine, blockEnd,
            calloutTitle, contentLines, noteLines,
            tableRows, captured: tableRows.get('Captured') ?? '',
        })

        i = blockEnd
    }

    return blocks
}

// ─── New-block assembly ──────────────────────────────────────────────────────

const TITLE_TO_QC: Record<string, string> = {
    'clip':          'qc_highlight',
    '':              'qc_highlight',
    'tweet':         'qc_tweet',
    'pdf highlight': 'qc_pdf_highlight',
    'image':         'qc_image',
}

const QC_LABEL: Record<string, string> = {
    qc_highlight:     'Highlight',
    qc_tweet:         'Tweet',
    qc_pdf_highlight: 'PDF Highlight',
    qc_image:         'Image',
}

function buildNewBlock(block: OldBlock, hash: string): string {
    const qcType = TITLE_TO_QC[block.calloutTitle.toLowerCase()] ?? 'qc_highlight'
    const baseLabel = QC_LABEL[qcType] ?? 'Highlight'

    const previewText = block.contentLines.filter(l => !l.startsWith('!['))
    const label = previewText.length > 0 ? `${baseLabel} — ${clipPreview(previewText)}` : baseLabel

    // Source link in parent body (highlight + tweet only)
    let sourceLink: string | null = null
    if (qcType === 'qc_highlight') {
        const open = block.tableRows.get('Open')
        if (open) {
            const m = open.match(/\[([^\]]+)\]\(([^)]+)\)/)
            if (m) {
                const text = m[1] ?? ''
                const href = m[2] ?? ''
                sourceLink = `[${text.includes('↗') ? text : text + ' ↗'}](${href})`
            }
        }
    } else if (qcType === 'qc_tweet') {
        const viewTweet = block.tableRows.get('View tweet')
        if (viewTweet) {
            sourceLink = viewTweet.replace(/\[[^\]]*\]\(([^)]+)\)/, (_, url) => `[View tweet ↗](${url})`)
        }
    }

    // Detail rows
    const detailRows: string[] = []
    if (qcType === 'qc_tweet') {
        const author = block.tableRows.get('Author')
        if (author) detailRows.push(`| Author | ${author} |`)
    }
    if (qcType === 'qc_pdf_highlight') {
        const source = block.tableRows.get('Source')
        if (source) detailRows.push(`| Source | ${source} |`)
        const page = block.tableRows.get('Page')
        if (page) detailRows.push(`| Page | ${page} |`)
    }
    if (qcType === 'qc_image') {
        const caption = block.tableRows.get('Image caption')
        if (caption) detailRows.push(`| Caption | ${caption} |`)
    }
    detailRows.push(`| Captured | ${block.captured} |`)
    const tags = block.tableRows.get('Tags')
    if (tags) detailRows.push(`| Tags | ${tags} |`)
    detailRows.push(`| QuickClip Hash | ${hash} |`)

    // Assemble
    let s = `> [!${qcType}]- ${label}\n`
    s += block.contentLines.map(l => `> ${l}`).join('\n') + '\n'
    s += '>\n'
    if (sourceLink) s += `> ${sourceLink}\n>\n`
    if (block.noteLines.length > 0) {
        s += `> > [!qc_note]- Note\n`
        s += block.noteLines.map(l => `> > ${l}`).join('\n') + '\n'
        s += '>\n'
    }
    s += `> > [!qc_details]- Details\n`
    s += `> > | Property | Value |\n`
    s += `> > | --- | --- |\n`
    s += detailRows.map(r => `> > ${r}`).join('\n') + '\n'
    s += '\n---\n\n'

    return s
}

// ─── Core per-file migration ─────────────────────────────────────────────────

async function processOneFile(
    app: App,
    filePath: string,
    clipsForFile: Array<{ url: string; clip: Clip }>,
    index: ClipsIndex,
    report: MigrationReport
): Promise<{ fileModified: boolean; indexModified: boolean }> {
    const file = app.vault.getAbstractFileByPath(filePath)
    if (!(file instanceof TFile)) return { fileModified: false, indexModified: false }

    const content = await app.vault.read(file)
    if (!/^> \[!(quote|clip)\]/im.test(content)) { report.skipped++; return { fileModified: false, indexModified: false } }
    const lines = content.split('\n')
    const blocks = findOldBlocks(lines)
    if (blocks.length === 0) { report.skipped++; return { fileModified: false, indexModified: false } }

    let fileModified = false
    let indexModified = false

    // Reverse order: splice later blocks first so earlier indices stay valid
    for (let b = blocks.length - 1; b >= 0; b--) {
        const block = blocks[b]
        const preview = clipPreview(block.contentLines.filter(l => !l.startsWith('![')), 40)
            || block.calloutTitle

        if (!block.captured) {
            report.results.push({ filePath, preview, status: 'error',
                reason: 'Could not find Captured date in metadata table' })
            continue
        }

        // ── Resolve hash ───────────────────────────────────────────────
        let hash: string | null = null

        // Images store hash directly as "Image ID"
        hash = block.tableRows.get('Image ID') ?? null

        if (!hash) {
            const matches = clipsForFile.filter(({ clip }) => {
                if (!clip.savedAt) return false
                return formatCaptured(clip.savedAt) === block.captured
            })

            if (matches.length > 1) {
                report.results.push({ filePath, preview, status: 'error',
                    reason: 'Two clips saved in the same minute — cannot determine which index entry to use' })
                continue
            }

            if (matches.length === 1) {
                if (matches[0].clip.hash) {
                    hash = matches[0].clip.hash
                } else {
                    // Index entry exists but hash is missing — generate and patch in place
                    hash = generateHash(filePath + block.captured)
                    matches[0].clip.hash = hash
                    indexModified = true
                }
            }
        }

        // ── Orphaned: not in index ─────────────────────────────────────
        if (!hash) {
            // Find URL from nearest heading above the block
            let url = ''
            for (let li = block.blockStart - 1; li >= 0; li--) {
                const hm = lines[li].match(/^#+\s+\[.*?\]\(([^)]+)\)/)
                if (hm) { url = hm[1]; break }
            }

            if (!url) {
                report.results.push({ filePath, preview, status: 'warning',
                    reason: 'Clip is not in clipsHistory.json and no URL heading found — skipped' })
                continue
            }

            hash = generateHash(filePath + block.captured)

            const qcType = TITLE_TO_QC[block.calloutTitle.toLowerCase()] ?? 'qc_highlight'
            const clipType = qcType === 'qc_highlight' ? 'highlight'
                : qcType === 'qc_tweet' ? 'tweet'
                : qcType === 'qc_pdf_highlight' ? 'pdf-highlight'
                : 'image'
            const savedAt = parseCapturedToIso(block.captured)
            const tags = (block.tableRows.get('Tags') ?? '')
                .split(/\s+/).filter(Boolean).map((t: string) => t.replace(/^#/, ''))

            const newClip: Clip = { clip_type: clipType, hash, savedAt, path: filePath, tags }
            if (clipType === 'highlight')
                newClip.text = block.contentLines.join(' ').slice(0, 500)

            if (!index[url]) {
                const domain = (() => { try { return new URL(url).hostname } catch { return 'unknown' } })()
                const content_type = clipType === 'tweet' ? 'tweet'
                    : clipType === 'pdf-highlight' ? 'pdf'
                    : 'article'
                index[url] = {
                    title: '', content_type, type: 'Note',
                    organized: false, archived: false, belongs_to: '', related_to: [],
                    domain, first_clipped: savedAt, last_clipped: savedAt, clips: [],
                }
            }
            index[url].clips.push(newClip)
            indexModified = true

            report.results.push({ filePath, preview, status: 'warning',
                reason: 'Clip was not in clipsHistory.json — reconstructed and added' })
        }

        // ── Replace block in lines array ───────────────────────────────
        const startWithBlank = block.blockStart > 0 && lines[block.blockStart - 1] === ''
            ? block.blockStart - 1 : block.blockStart

        const newLines = buildNewBlock(block, hash).split('\n')
        // buildNewBlock ends with '\n---\n\n', so split gives a trailing ''
        while (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop()

        // Re-insert the preceding blank line if we consumed it
        if (startWithBlank < block.blockStart) newLines.unshift('')

        lines.splice(startWithBlank, block.blockEnd - startWithBlank, ...newLines)
        fileModified = true
        report.migrated++
    }

    if (fileModified) await app.vault.modify(file, lines.join('\n'))
    return { fileModified, indexModified }
}

// ─── Scan for files with old-format clips ────────────────────────────────────

export async function scanOldFormatFiles(app: App): Promise<{ filePath: string; blockCount: number }[]> {
    const results: { filePath: string; blockCount: number }[] = []

    for (const file of app.vault.getMarkdownFiles()) {
        const content = await app.vault.read(file)
        if (!/^> \[!(quote|clip)\]/im.test(content)) continue
        const blocks = findOldBlocks(content.split('\n'))
        if (blocks.length > 0) results.push({ filePath: file.path, blockCount: blocks.length })
    }

    return results.sort((a, b) => b.blockCount - a.blockCount)
}

// ─── Migrate a single file ───────────────────────────────────────────────────

export async function migrateOldFormatFile(app: App, filePath: string): Promise<MigrationReport> {
    const index = await loadIndex(app)
    const report: MigrationReport = { migrated: 0, skipped: 0, results: [] }

    const clipsForFile: Array<{ url: string; clip: Clip }> = []
    for (const [url, entry] of Object.entries(index)) {
        for (const clip of (entry.clips ?? [])) {
            if (clip.path === filePath) clipsForFile.push({ url, clip })
        }
    }

    const { indexModified } = await processOneFile(app, filePath, clipsForFile, index, report)
    if (indexModified) await saveIndex(app, index)

    return report
}

// ─── Migrate all files ───────────────────────────────────────────────────────

export async function migrateOldFormatClips(app: App): Promise<MigrationReport> {
    const index = await loadIndex(app)
    const report: MigrationReport = { migrated: 0, skipped: 0, results: [] }

    // Build reverse map: filePath → index entries for fast lookup
    type IndexEntry = { url: string; clip: Clip }
    const fileToClips = new Map<string, IndexEntry[]>()
    for (const [url, entry] of Object.entries(index)) {
        for (const clip of (entry.clips ?? [])) {
            if (!clip.path) continue
            if (!fileToClips.has(clip.path)) fileToClips.set(clip.path, [])
            fileToClips.get(clip.path)!.push({ url, clip })
        }
    }

    // Also include unindexed markdown files that may contain old-format clips
    for (const file of app.vault.getMarkdownFiles()) {
        if (!fileToClips.has(file.path)) fileToClips.set(file.path, [])
    }

    let anyIndexModified = false

    for (const filePath of fileToClips.keys()) {
        const { indexModified } = await processOneFile(
            app, filePath, fileToClips.get(filePath)!, index, report
        )
        if (indexModified) anyIndexModified = true
    }

    if (anyIndexModified) await saveIndex(app, index)

    return report
}
