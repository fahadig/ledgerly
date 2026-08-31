const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'at', 'by', 'from', 'with',
  'inc', 'llc', 'ltd', 'co', 'company', 'pvt', 'limited', 'invoice', 'bill', 'payment',
  'paid', 'purchase', 'ref', 'no', 'number', 'monthly', 'month', 'services', 'service',
  'was', 'were', 'has', 'have', 'this', 'that', 'our', 'their', 'its',
]);

/** Lower-cased, punctuation-free, stopword-free content words. */
export function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}
