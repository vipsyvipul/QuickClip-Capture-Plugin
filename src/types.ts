export type ClipType = 'highlight' | 'full-page' | 'transcript' | 'tweet' | 'pdf-highlight' | 'image'
export type ContentType = 'article' | 'video' | 'tweet' | 'pdf' | 'github'

export interface Clip {
    clip_type: ClipType
    hash: string
    savedAt: string
    path: string
    tags: string[]
    text?: string
    // full-page
    word_count?: number
    author?: string
    published_date?: string
    // transcript
    video_id?: string
    channel?: string
    duration?: number
    // tweet
    tweet_id?: string
    author_handle?: string
    thread_length?: number
    // pdf
    page_number?: number
}

export interface UrlEntry {
    title: string
    content_type: ContentType
    type: string
    organized: boolean
    archived: boolean
    belongs_to: string
    related_to: string[]
    domain: string
    first_clipped: string
    last_clipped: string
    clips: Clip[]
}

export type ClipsIndex = Record<string, UrlEntry>

export interface ClipRef {
    url: string
    pageTitle: string
    domain: string
    content_type: ContentType
    clip: Clip
}
