/**
 * Top-k selection over an iterable via a size-k min-heap.
 *
 * O(N log k) instead of the naïve "collect all N, sort O(N log N), slice k". Used on the
 * BM25 hot path where N (union of postings of the query terms) can be tens of thousands on
 * a 100k vault while k stays small (~100). The heap retains only the k BEST items seen so
 * far: when full, a new item replaces the smallest only if it beats it.
 *
 * `score(item)` should be larger for "better" — the heap drops the lowest-scoring item
 * when full. Result is returned best-first.
 */

export function topK<T>(items: Iterable<T>, k: number, score: (item: T) => number): T[] {
  if (k <= 0) return []
  // Min-heap as a binary heap in an array: parent(i) = (i-1)>>1, children(i) = 2i+1, 2i+2.
  // We store [score, item] pairs so we don't re-compute score on every comparison.
  const heap: Array<[number, T]> = []

  for (const item of items) {
    const s = score(item)
    if (heap.length < k) {
      heap.push([s, item])
      siftUp(heap, heap.length - 1)
    } else if (s > heap[0][0]) {
      heap[0] = [s, item]
      siftDown(heap, 0)
    }
  }

  // Drain min-first, reverse to get best-first.
  const out: T[] = []
  while (heap.length > 0) {
    out.push(heap[0][1])
    const last = heap[heap.length - 1]
    heap.pop()
    if (heap.length > 0) {
      heap[0] = last
      siftDown(heap, 0)
    }
  }
  return out.reverse()
}

function siftUp<T>(heap: Array<[number, T]>, i: number): void {
  while (i > 0) {
    const parent = (i - 1) >>> 1
    if (heap[i][0] >= heap[parent][0]) break
    ;[heap[i], heap[parent]] = [heap[parent], heap[i]]
    i = parent
  }
}

function siftDown<T>(heap: Array<[number, T]>, i: number): void {
  const n = heap.length
  for (;;) {
    const l = 2 * i + 1
    const r = 2 * i + 2
    let smallest = i
    if (l < n && heap[l][0] < heap[smallest][0]) smallest = l
    if (r < n && heap[r][0] < heap[smallest][0]) smallest = r
    if (smallest === i) break
    ;[heap[i], heap[smallest]] = [heap[smallest], heap[i]]
    i = smallest
  }
}
