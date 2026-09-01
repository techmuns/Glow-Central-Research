// User-facing copy should describe what a feed is without repeating this publisher's brand.
// The raw values and URLs remain untouched for matching, ordering, and direct links.
export function withoutPublisherName(value) {
  return String(value ?? '').replace(/\bmoney\s*control\b/gi, 'the publisher');
}
