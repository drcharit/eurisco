export async function webSearch(query: string): Promise<string> {
  console.log(`[web_search] query="${query}"`);

  // Use Google Custom Search JSON API (free 100 queries/day)
  const apiKey = process.env["GOOGLE_SEARCH_API_KEY"];
  const cx = process.env["GOOGLE_SEARCH_CX"];

  if (apiKey && cx) {
    return googleCustomSearch(query, apiKey, cx);
  }

  // Fallback: scrape Google search results
  return googleScrapeSearch(query);
}

async function googleCustomSearch(query: string, apiKey: string, cx: string): Promise<string> {
  const params = new URLSearchParams({
    key: apiKey,
    cx,
    q: query,
    num: "5",
  });

  const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  if (!res.ok) return `Search error: ${res.status}`;

  const data = await res.json() as { items?: { title: string; link: string; snippet: string }[] };
  const items = data.items ?? [];

  if (items.length === 0) return `No results found for "${query}"`;

  return items
    .map((item) => `${item.title}\n${item.link}\n${item.snippet}`)
    .join("\n\n");
}

async function googleScrapeSearch(query: string): Promise<string> {
  // Google search via scraping (no API key needed)
  const params = new URLSearchParams({ q: query, num: "8", hl: "en" });
  const res = await fetch(`https://www.google.com/search?${params}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) return `Search error: ${res.status}`;

  const html = await res.text();

  // Extract search result blocks
  const results: string[] = [];
  // Match <a href="/url?q=URL"> patterns followed by content
  const linkPattern = /href="\/url\?q=([^&"]+)[^"]*"[^>]*>/g;
  const urls: string[] = [];
  const MAX_RESULTS = 8;

  for (let i = 0; i < 50; i++) {
    const match = linkPattern.exec(html);
    if (!match) break;
    const url = decodeURIComponent(match[1]!);
    // Skip Google's own links
    if (url.includes("google.com") || url.includes("accounts.google") || url.includes("support.google")) continue;
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= MAX_RESULTS) break;
  }

  // Extract visible text snippets near each URL
  // Strip HTML to text and find relevant chunks
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "\n")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Build results with URLs and nearby text
  for (const url of urls) {
    const domain = url.replace(/https?:\/\//, "").split("/")[0] ?? url;
    // Find text near this URL in the stripped content
    const idx = text.indexOf(domain);
    let snippet = "";
    if (idx >= 0) {
      snippet = text.slice(Math.max(0, idx - 50), idx + 200).replace(/\n+/g, " ").trim();
    }
    results.push(`${domain}\n${url}\n${snippet}`);
  }

  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  return results.join("\n\n");
}

export async function webFetch(url: string): Promise<string> {
  console.log(`[web_fetch] url="${url}"`);

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Eurisco/1.0)" },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) return `Fetch error: ${res.status} ${res.statusText}`;

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
    return `Non-text content: ${contentType}`;
  }

  const html = await res.text();

  // Try to extract main content area first (article, main, or first large content block)
  const contentMatch = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  const source = contentMatch ? contentMatch[1]! : html;

  // Strip non-content elements
  const cleaned = source
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "");

  // Convert structural tags to newlines for readability
  const text = cleaned
    .replace(/<\/(?:p|div|li|tr|h[1-6]|br)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();

  const MAX_LEN = 6000;
  if (text.length > MAX_LEN) {
    return text.slice(0, MAX_LEN) + "\n... (truncated)";
  }

  return text;
}
