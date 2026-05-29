/**
 * The n-gram width. Used for BOTH the postings n-grams and the query-acceleration floor —
 * they must be equal: a literal query shorter than one n-gram has no full n-gram to filter
 * on, so it must fall back to a full scan rather than query (empty) postings. Drift between
 * the two would silently return no matches for queries of length < the n-gram size.
 */
export const TRIGRAM_SIZE = 3
